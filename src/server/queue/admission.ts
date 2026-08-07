import { and, desc, eq, inArray, sql } from "drizzle-orm"

import type { FieldCipher } from "../db/contracts"
import { EpochMillisecondsSchema } from "../db/ids"
import { bots, invocations, jobs } from "../db/schema"
import type { ClawbotDatabase } from "../db/types"
import {
  calculateAdmissionEstimate,
  calculateAdmissionRetryAfter,
  calculateRateInterval,
} from "../rate/policy"
import { TransactionalRateRepository } from "../rate/repository"
import {
  type AdmissionResult,
  IDEMPOTENCY_TTL_MS,
  JOB_DEADLINE_MS,
  MAX_NONTERMINAL_JOBS,
  MINIMUM_ATTEMPT_BUDGET_MS,
  type QueueClock,
  type SingleAdmissionCommand,
} from "./contracts"
import { createSingleRequestDigest, hashIdempotencyKey } from "./idempotency"
import { encryptJobFields, mapJob } from "./persistence"

const NONTERMINAL_JOB_STATUSES = ["queued", "leased", "retry_wait"] as const

class QueuePersistenceError extends Error {
  readonly name = "QueuePersistenceError"
}

export function admit(
  database: ClawbotDatabase,
  cipher: FieldCipher,
  clock: QueueClock,
  command: SingleAdmissionCommand,
): AdmissionResult {
  return database.transaction(
    (transaction) => {
      const now = clock.now()
      const scope = command.idempotencyKey === null ? null : `single:${command.botId}`
      const keyHash =
        command.idempotencyKey === null ? null : hashIdempotencyKey(command.idempotencyKey)
      const requestDigest =
        command.idempotencyKey === null
          ? null
          : createSingleRequestDigest(command.recipient, command.text)

      if (scope !== null && keyHash !== null && requestDigest !== null) {
        const replay = resolveIdempotency(transaction, scope, keyHash, requestDigest, now)
        if (replay !== null) {
          return replay
        }
      }

      const capacity = transaction
        .select({
          count: sql<number>`count(*)`,
          earliestDeadline: sql<number | null>`min(${jobs.deadlineAt})`,
        })
        .from(jobs)
        .where(and(eq(jobs.botId, command.botId), inArray(jobs.status, NONTERMINAL_JOB_STATUSES)))
        .get()
      if (capacity === undefined) {
        throw new QueuePersistenceError("queue capacity query returned no row")
      }
      if (capacity.count >= MAX_NONTERMINAL_JOBS) {
        if (capacity.earliestDeadline === null) {
          throw new QueuePersistenceError("full queue has no nonterminal deadline")
        }
        return {
          kind: "queue_full",
          retryAfter: calculateAdmissionRetryAfter(
            EpochMillisecondsSchema.parse(capacity.earliestDeadline),
            now,
          ),
        }
      }

      const bot = transaction
        .select({ maxSendsPerMinute: bots.maxSendsPerMinute })
        .from(bots)
        .where(eq(bots.id, command.botId))
        .get()
      if (bot === undefined) {
        throw new QueuePersistenceError("admission bot does not exist")
      }
      const rate = new TransactionalRateRepository(transaction).get(command.botId)
      const intervalMs = calculateRateInterval(bot.maxSendsPerMinute, command.currentCeiling)
      const tail = transaction
        .select({ admissionEstimatedAt: jobs.admissionEstimatedAt })
        .from(jobs)
        .where(and(eq(jobs.botId, command.botId), inArray(jobs.status, NONTERMINAL_JOB_STATUSES)))
        .orderBy(desc(jobs.admissionEstimatedAt), desc(jobs.createdAt), desc(jobs.id))
        .limit(1)
        .get()
      const estimatedAt = calculateAdmissionEstimate(
        now,
        rate.nextEligibleAt,
        rate.cooldownUntil,
        tail?.admissionEstimatedAt ?? null,
        intervalMs,
      )
      const deadlineAt = EpochMillisecondsSchema.parse(now + JOB_DEADLINE_MS)
      if (estimatedAt + MINIMUM_ATTEMPT_BUDGET_MS > deadlineAt) {
        return {
          kind: "deadline_unavailable",
          estimatedAt,
          retryAfter: calculateAdmissionRetryAfter(estimatedAt, now),
        }
      }

      transaction
        .insert(invocations)
        .values({
          id: command.invocationId,
          requestId: command.requestId,
          endpoint: "single",
          botId: command.botId,
          status: "queued",
          idempotencyScope: scope,
          idempotencyKeyHash: keyHash,
          requestDigest,
          userFingerprint: command.userFingerprint,
          deadlineAt,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      const encrypted = encryptJobFields(cipher, command)
      const row = transaction
        .insert(jobs)
        .values({
          id: command.jobId,
          invocationId: command.invocationId,
          botId: command.botId,
          status: "queued",
          clientId: `clawbot-${command.jobId}`,
          ...encrypted,
          recipientLookupHash: command.recipientLookupHash,
          userFingerprint: command.userFingerprint,
          admissionEstimatedAt: estimatedAt,
          retryNotBefore: now,
          deadlineAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get()
      if (row === undefined) {
        throw new QueuePersistenceError("admitted job insert returned no row")
      }
      return { kind: "admitted", job: mapJob(row, cipher) }
    },
    { behavior: "immediate" },
  )
}

function resolveIdempotency(
  transaction: Parameters<Parameters<ClawbotDatabase["transaction"]>[0]>[0],
  scope: string,
  keyHash: string,
  requestDigest: string,
  now: ReturnType<QueueClock["now"]>,
): AdmissionResult | null {
  const existing = transaction
    .select()
    .from(invocations)
    .where(
      and(eq(invocations.idempotencyScope, scope), eq(invocations.idempotencyKeyHash, keyHash)),
    )
    .get()
  if (existing === undefined) {
    return null
  }
  if (existing.createdAt + IDEMPOTENCY_TTL_MS <= now) {
    transaction.delete(invocations).where(eq(invocations.id, existing.id)).run()
    return null
  }
  if (existing.requestDigest !== requestDigest) {
    return { kind: "idempotency_conflict", invocationId: existing.id }
  }
  const job = transaction
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.invocationId, existing.id))
    .get()
  if (job === undefined) {
    throw new QueuePersistenceError("single invocation has no job")
  }
  if (existing.responseHttpStatus !== null && existing.responseBody !== null) {
    return {
      kind: "replayed_terminal",
      invocationId: existing.id,
      jobId: job.id,
      response: {
        httpStatus: existing.responseHttpStatus,
        body: existing.responseBody,
        retryAfter: existing.responseRetryAfter,
      },
    }
  }
  return {
    kind: "replayed_in_flight",
    invocationId: existing.id,
    jobId: job.id,
    deadlineAt: existing.deadlineAt,
  }
}
