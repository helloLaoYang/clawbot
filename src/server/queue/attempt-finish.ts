import { and, eq, gt } from "drizzle-orm"

import { EpochMillisecondsSchema } from "../db/ids"
import { attempts, invocations, jobs } from "../db/schema"
import type { ClawbotDatabase } from "../db/types"
import { TransactionalRateRepository } from "../rate/repository"
import type {
  FailureClassification,
  FinalizeSuccessCommand,
  QueueClock,
  RecordFailureCommand,
  RecordFailureResult,
} from "./contracts"
import { hasServiceFence } from "./fence"

export function recordFailure(
  database: ClawbotDatabase,
  clock: QueueClock,
  input: RecordFailureCommand,
): RecordFailureResult {
  return database.transaction(
    (transaction) => {
      const now = clock.now()
      if (!hasServiceFence(transaction, input.serviceFence, now)) {
        return { kind: "service_fence_lost" }
      }
      const job = transaction.select().from(jobs).where(currentLeaseWhere(input, now)).get()
      const attempt = transaction
        .select()
        .from(attempts)
        .where(
          and(
            eq(attempts.jobId, input.jobId),
            eq(attempts.attempt, input.attempt),
            eq(attempts.classification, "in_flight"),
          ),
        )
        .get()
      if (job === undefined || attempt === undefined) {
        return { kind: "lease_lost" }
      }
      const updated = transaction
        .update(jobs)
        .set({ status: "retry_wait", ownerId: null, leaseUntil: null, updatedAt: now })
        .where(currentLeaseWhere(input, now))
        .run()
      if (updated.changes !== 1) {
        return { kind: "lease_lost" }
      }

      const rateRepository = new TransactionalRateRepository(transaction)
      const storedRate = rateRepository.get(job.botId)
      const rate = applyRateOutcome(
        rateRepository,
        storedRate,
        input.classification,
        now,
        input.retryAfter,
      )
      const retryNotBefore = EpochMillisecondsSchema.parse(
        Math.max(now + input.backoffMs, rate.cooldownUntil),
      )
      transaction
        .update(jobs)
        .set({ retryNotBefore, updatedAt: now })
        .where(eq(jobs.id, job.id))
        .run()
      transaction
        .update(attempts)
        .set({
          classification: input.classification,
          httpStatus: input.httpStatus,
          tencentRet: input.tencentRet,
          durationMs: now - attempt.startedAt,
          completedAt: now,
        })
        .where(eq(attempts.id, attempt.id))
        .run()
      transaction
        .update(invocations)
        .set({ status: "retry_wait", updatedAt: now })
        .where(eq(invocations.id, job.invocationId))
        .run()
      return {
        kind: "recorded",
        retryNotBefore,
        cooldownUntil: rate.cooldownUntil,
        consecutiveRateLimits: rate.consecutiveRateLimits,
      }
    },
    { behavior: "immediate" },
  )
}

export function finalizeSuccess(
  database: ClawbotDatabase,
  clock: QueueClock,
  input: FinalizeSuccessCommand,
): boolean {
  return database.transaction(
    (transaction) => {
      const now = clock.now()
      if (!hasServiceFence(transaction, input.serviceFence, now)) {
        return false
      }
      const job = transaction.select().from(jobs).where(currentLeaseWhere(input, now)).get()
      const attempt = transaction
        .select()
        .from(attempts)
        .where(
          and(
            eq(attempts.jobId, input.jobId),
            eq(attempts.attempt, input.attempt),
            eq(attempts.classification, "in_flight"),
          ),
        )
        .get()
      if (job === undefined || attempt === undefined || input.messageId !== job.clientId) {
        return false
      }
      const finalized = transaction
        .update(jobs)
        .set({
          status: "succeeded",
          ownerId: null,
          leaseUntil: null,
          messageId: input.messageId,
          resultHttpStatus: input.responseHttpStatus,
          errorCode: null,
          errorMessage: null,
          errorRetryable: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(currentLeaseWhere(input, now))
        .run()
      if (finalized.changes !== 1) {
        return false
      }
      transaction
        .update(attempts)
        .set({
          classification: "success",
          httpStatus: 200,
          tencentRet: 0,
          durationMs: now - attempt.startedAt,
          completedAt: now,
        })
        .where(eq(attempts.id, attempt.id))
        .run()
      const rateRepository = new TransactionalRateRepository(transaction)
      rateRepository.resetRateLimit(rateRepository.get(job.botId), now)
      transaction
        .update(invocations)
        .set({
          status: "succeeded",
          responseHttpStatus: input.responseHttpStatus,
          responseBody: input.responseBody,
          responseRetryAfter: input.responseRetryAfter,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(invocations.id, job.invocationId))
        .run()
      return true
    },
    { behavior: "immediate" },
  )
}

function applyRateOutcome(
  repository: TransactionalRateRepository,
  state: ReturnType<TransactionalRateRepository["get"]>,
  classification: FailureClassification,
  now: ReturnType<QueueClock["now"]>,
  retryAfter: string | null,
) {
  switch (classification) {
    case "rate_limited":
      return repository.recordRateLimit(state, now, retryAfter)
    case "network":
    case "timeout":
    case "upstream_http":
    case "upstream_protocol":
    case "reauth_required":
      return state
    default:
      classification satisfies never
      return state
  }
}

function currentLeaseWhere(
  input: Pick<RecordFailureCommand, "jobId" | "ownerId" | "leaseGeneration">,
  now: ReturnType<QueueClock["now"]>,
) {
  return and(
    eq(jobs.id, input.jobId),
    eq(jobs.status, "leased"),
    eq(jobs.ownerId, input.ownerId),
    eq(jobs.leaseGeneration, input.leaseGeneration),
    gt(jobs.leaseUntil, now),
  )
}
