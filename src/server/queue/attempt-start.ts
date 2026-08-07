import { randomUUID } from "node:crypto"

import { and, asc, eq, gt, inArray } from "drizzle-orm"

import { AttemptIdSchema, EpochMillisecondsSchema } from "../db/ids"
import { attempts, bots, invocations, jobs } from "../db/schema"
import type { ClawbotDatabase } from "../db/types"
import {
  calculateEligibility,
  calculateRateInterval,
  calculateTerminalRateRetryAfter,
} from "../rate/policy"
import { TransactionalRateRepository } from "../rate/repository"
import {
  MINIMUM_ATTEMPT_BUDGET_MS,
  type PrepareAttemptCommand,
  type PrepareAttemptResult,
  type QueueClock,
} from "./contracts"
import { hasServiceFence } from "./fence"

const NONTERMINAL_JOB_STATUSES = ["queued", "leased", "retry_wait"] as const

type TerminalizeInput = {
  readonly transaction: Parameters<Parameters<ClawbotDatabase["transaction"]>[0]>[0]
  readonly job: typeof jobs.$inferSelect
  readonly lease: PrepareAttemptCommand
  readonly now: ReturnType<QueueClock["now"]>
  readonly httpStatus: 429 | 504
  readonly retryAfter: number | null
}

export function prepareAttempt(
  database: ClawbotDatabase,
  clock: QueueClock,
  input: PrepareAttemptCommand,
): PrepareAttemptResult {
  return database.transaction(
    (transaction) => {
      const now = clock.now()
      if (!hasServiceFence(transaction, input.serviceFence, now)) {
        return { kind: "service_fence_lost" }
      }
      const job = transaction.select().from(jobs).where(eq(jobs.id, input.jobId)).get()
      if (!isCurrentLease(job, input, now)) {
        return { kind: "lease_lost" }
      }
      const head = transaction
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.botId, job.botId), inArray(jobs.status, NONTERMINAL_JOB_STATUSES)))
        .orderBy(asc(jobs.createdAt), asc(jobs.id))
        .limit(1)
        .get()
      if (head?.id !== job.id) {
        return { kind: "lease_lost" }
      }
      const bot = transaction
        .select({ maxSendsPerMinute: bots.maxSendsPerMinute })
        .from(bots)
        .where(eq(bots.id, job.botId))
        .get()
      if (bot === undefined) {
        return { kind: "lease_lost" }
      }
      const rateRepository = new TransactionalRateRepository(transaction)
      const storedRate = rateRepository.get(job.botId)
      const intervalMs = calculateRateInterval(bot.maxSendsPerMinute, input.currentCeiling)
      const eligibility = calculateEligibility({
        retryNotBefore: job.retryNotBefore,
        cooldownUntil: storedRate.cooldownUntil,
        nextEligibleAt: storedRate.nextEligibleAt,
        lastAttemptAt: storedRate.lastAttemptAt,
        intervalMs,
      })
      const rate = rateRepository.projectNextEligible(
        storedRate,
        eligibility.effectiveNextEligibleAt,
        now,
      )

      if (job.deadlineAt <= now) {
        terminalize({ transaction, job, lease: input, now, httpStatus: 504, retryAfter: null })
        return {
          kind: "terminal",
          intervalMs,
          eligibleAt: eligibility.eligibleAt,
          httpStatus: 504,
          retryAfter: null,
        }
      }
      if (now < eligibility.eligibleAt) {
        if (job.deadlineAt - eligibility.eligibleAt >= MINIMUM_ATTEMPT_BUDGET_MS) {
          const deferred = transaction
            .update(jobs)
            .set({
              status: "retry_wait",
              retryNotBefore: eligibility.eligibleAt,
              ownerId: null,
              leaseUntil: null,
              updatedAt: now,
            })
            .where(currentLeaseWhere(input, now))
            .run()
          if (deferred.changes !== 1) {
            return { kind: "lease_lost" }
          }
          transaction
            .update(invocations)
            .set({ status: "retry_wait", updatedAt: now })
            .where(eq(invocations.id, job.invocationId))
            .run()
          return { kind: "deferred", intervalMs, eligibleAt: eligibility.eligibleAt }
        }
        const rateDriven =
          eligibility.rateEligibleAt >= job.retryNotBefore && eligibility.rateEligibleAt > now
        const httpStatus = rateDriven ? 429 : 504
        const retryAfter = rateDriven
          ? calculateTerminalRateRetryAfter(
              EpochMillisecondsSchema.parse(
                Math.max(rate.cooldownUntil, rate.nextEligibleAt, eligibility.rateEligibleAt),
              ),
              now,
            )
          : null
        terminalize({ transaction, job, lease: input, now, httpStatus, retryAfter })
        return {
          kind: "terminal",
          intervalMs,
          eligibleAt: eligibility.eligibleAt,
          httpStatus,
          retryAfter,
        }
      }

      const inFlight = transaction
        .select({ id: attempts.id })
        .from(attempts)
        .where(and(eq(attempts.jobId, job.id), eq(attempts.classification, "in_flight")))
        .get()
      if (inFlight !== undefined) {
        return { kind: "lease_lost" }
      }
      const attempt = job.attemptCount + 1
      const attemptId = AttemptIdSchema.parse(randomUUID())
      const updated = transaction
        .update(jobs)
        .set({ attemptCount: attempt, updatedAt: now })
        .where(currentLeaseWhere(input, now))
        .run()
      if (updated.changes !== 1) {
        return { kind: "lease_lost" }
      }
      rateRepository.reserveSlot(rate, now, EpochMillisecondsSchema.parse(now + intervalMs))
      transaction
        .insert(attempts)
        .values({
          id: attemptId,
          jobId: job.id,
          attempt,
          classification: "in_flight",
          startedAt: now,
        })
        .run()
      transaction
        .update(invocations)
        .set({ status: "leased", attemptCount: attempt, updatedAt: now })
        .where(eq(invocations.id, job.invocationId))
        .run()
      return { kind: "started", intervalMs, eligibleAt: eligibility.eligibleAt, attemptId, attempt }
    },
    { behavior: "immediate" },
  )
}

function isCurrentLease(
  job: typeof jobs.$inferSelect | undefined,
  input: PrepareAttemptCommand,
  now: ReturnType<QueueClock["now"]>,
): job is typeof jobs.$inferSelect {
  return (
    job !== undefined &&
    job.status === "leased" &&
    job.ownerId === input.ownerId &&
    job.leaseGeneration === input.leaseGeneration &&
    job.leaseUntil !== null &&
    job.leaseUntil > now
  )
}

function currentLeaseWhere(input: PrepareAttemptCommand, now: ReturnType<QueueClock["now"]>) {
  return and(
    eq(jobs.id, input.jobId),
    eq(jobs.status, "leased"),
    eq(jobs.ownerId, input.ownerId),
    eq(jobs.leaseGeneration, input.leaseGeneration),
    gt(jobs.leaseUntil, now),
  )
}

function terminalize(input: TerminalizeInput): void {
  const status = input.httpStatus === 429 ? "failed" : "deadline_exceeded"
  input.transaction
    .update(jobs)
    .set({
      status,
      ownerId: null,
      leaseUntil: null,
      resultHttpStatus: input.httpStatus,
      errorCode: input.httpStatus === 429 ? "rate_limited" : "deadline_exceeded",
      errorRetryable: false,
      completedAt: input.now,
      updatedAt: input.now,
    })
    .where(currentLeaseWhere(input.lease, input.now))
    .run()
  input.transaction
    .update(invocations)
    .set({
      status,
      responseHttpStatus: input.httpStatus,
      responseRetryAfter: input.retryAfter,
      completedAt: input.now,
      updatedAt: input.now,
    })
    .where(eq(invocations.id, input.job.invocationId))
    .run()
}
