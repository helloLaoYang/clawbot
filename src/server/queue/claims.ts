import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm"

import type { FieldCipher } from "../db/contracts"
import { EpochMillisecondsSchema } from "../db/ids"
import { attempts, invocations, jobs } from "../db/schema"
import type { ClawbotDatabase } from "../db/types"
import {
  type ClaimCommand,
  type ClaimResult,
  JOB_LEASE_MS,
  type QueueClock,
  type RenewLeaseCommand,
} from "./contracts"
import { hasServiceFence } from "./fence"
import { mapJob } from "./persistence"

const NONTERMINAL_JOB_STATUSES = ["queued", "leased", "retry_wait"] as const

export function claim(
  database: ClawbotDatabase,
  cipher: FieldCipher,
  clock: QueueClock,
  input: ClaimCommand,
): ClaimResult {
  return database.transaction(
    (transaction) => {
      const now = clock.now()
      if (!hasServiceFence(transaction, input.serviceFence, now)) {
        return { kind: "service_fence_lost" }
      }
      const head = transaction
        .select()
        .from(jobs)
        .where(and(eq(jobs.botId, input.botId), inArray(jobs.status, NONTERMINAL_JOB_STATUSES)))
        .orderBy(asc(jobs.createdAt), asc(jobs.id))
        .limit(1)
        .get()
      if (head === undefined) {
        return { kind: "blocked" }
      }
      if (head.status === "leased" && (head.leaseUntil === null || head.leaseUntil > now)) {
        return { kind: "blocked" }
      }
      if (head.status === "leased") {
        transaction
          .update(attempts)
          .set({
            classification: "abandoned",
            completedAt: now,
            durationMs: sql`${now} - ${attempts.startedAt}`,
          })
          .where(and(eq(attempts.jobId, head.id), eq(attempts.classification, "in_flight")))
          .run()
      }
      if (head.deadlineAt <= now) {
        markDeadlineExceeded(transaction, head.id, head.invocationId, now)
        return { kind: "blocked" }
      }
      if (head.retryNotBefore > now) {
        return { kind: "blocked" }
      }
      const claimed = transaction
        .update(jobs)
        .set({
          status: "leased",
          ownerId: input.ownerId,
          leaseGeneration: sql`${jobs.leaseGeneration} + 1`,
          leaseUntil: EpochMillisecondsSchema.parse(now + JOB_LEASE_MS),
          updatedAt: now,
        })
        .where(
          and(
            eq(jobs.id, head.id),
            eq(jobs.status, head.status),
            eq(jobs.leaseGeneration, head.leaseGeneration),
            head.status === "leased" ? lte(jobs.leaseUntil, now) : undefined,
          ),
        )
        .returning()
        .get()
      if (claimed === undefined) {
        return { kind: "blocked" }
      }
      transaction
        .update(invocations)
        .set({ status: "leased", updatedAt: now })
        .where(eq(invocations.id, claimed.invocationId))
        .run()
      return { kind: "claimed", job: mapJob(claimed, cipher) }
    },
    { behavior: "immediate" },
  )
}

export function renewLease(
  database: ClawbotDatabase,
  clock: QueueClock,
  input: RenewLeaseCommand,
): boolean {
  const renewed = database.transaction(
    (transaction) => {
      const now = clock.now()
      if (!hasServiceFence(transaction, input.serviceFence, now)) {
        return false
      }
      return (
        transaction
          .update(jobs)
          .set({
            leaseUntil: EpochMillisecondsSchema.parse(now + JOB_LEASE_MS),
            updatedAt: now,
          })
          .where(
            and(
              eq(jobs.id, input.jobId),
              eq(jobs.status, "leased"),
              eq(jobs.ownerId, input.ownerId),
              eq(jobs.leaseGeneration, input.leaseGeneration),
              gt(jobs.leaseUntil, now),
            ),
          )
          .run().changes === 1
      )
    },
    { behavior: "immediate" },
  )
  if (!renewed) {
    input.abortController.abort()
  }
  return renewed
}

function markDeadlineExceeded(
  transaction: Parameters<Parameters<ClawbotDatabase["transaction"]>[0]>[0],
  jobId: typeof jobs.$inferSelect.id,
  invocationId: typeof invocations.$inferSelect.id,
  now: ReturnType<QueueClock["now"]>,
): void {
  transaction
    .update(jobs)
    .set({
      status: "deadline_exceeded",
      ownerId: null,
      leaseUntil: null,
      resultHttpStatus: 504,
      errorCode: "deadline_exceeded",
      errorRetryable: false,
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(jobs.id, jobId))
    .run()
  transaction
    .update(invocations)
    .set({ status: "deadline_exceeded", responseHttpStatus: 504, completedAt: now, updatedAt: now })
    .where(eq(invocations.id, invocationId))
    .run()
}
