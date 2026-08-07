import { and, asc, eq, inArray, lte, sql } from "drizzle-orm"

import type {
  AdmissionInput,
  ClaimInput,
  FieldCipher,
  JobRecord,
  RecordAttemptInput,
} from "../db/contracts"
import { attempts, invocations, jobs } from "../db/schema"
import type { ClawbotDatabase } from "../db/types"
import { encryptJobFields, mapJob } from "./persistence"

export function admitLegacy(
  database: ClawbotDatabase,
  cipher: FieldCipher,
  input: AdmissionInput,
): JobRecord {
  return database.transaction(
    (transaction) => {
      transaction
        .insert(invocations)
        .values({
          id: input.invocation.id,
          requestId: input.invocation.requestId,
          endpoint: input.invocation.endpoint,
          botId: input.invocation.botId,
          status: "queued",
          idempotencyScope: input.invocation.idempotencyScope,
          idempotencyKeyHash: input.invocation.idempotencyKeyHash,
          requestDigest: input.invocation.requestDigest,
          userFingerprint: input.invocation.userFingerprint,
          deadlineAt: input.invocation.deadlineAt,
          createdAt: input.invocation.createdAt,
          updatedAt: input.invocation.createdAt,
        })
        .run()
      const encrypted = encryptJobFields(cipher, {
        jobId: input.job.id,
        recipient: input.job.recipient,
        text: input.job.text,
        contextToken: input.job.contextToken,
      })
      const row = transaction
        .insert(jobs)
        .values({
          id: input.job.id,
          invocationId: input.invocation.id,
          botId: input.job.botId,
          status: "queued",
          clientId: input.job.clientId,
          ...encrypted,
          recipientLookupHash: input.job.recipientLookupHash,
          userFingerprint: input.job.userFingerprint,
          admissionEstimatedAt: input.job.admissionEstimatedAt,
          retryNotBefore: input.job.retryNotBefore,
          deadlineAt: input.job.deadlineAt,
          createdAt: input.job.createdAt,
          updatedAt: input.job.createdAt,
        })
        .returning()
        .get()
      if (row === undefined) {
        throw new LegacyQueueError("legacy admission insert returned no row")
      }
      return mapJob(row, cipher)
    },
    { behavior: "immediate" },
  )
}

export function claimLegacy(
  database: ClawbotDatabase,
  cipher: FieldCipher,
  input: ClaimInput,
): JobRecord | null {
  return database.transaction(
    (transaction) => {
      const head = transaction
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.botId, input.botId),
            inArray(jobs.status, ["queued", "retry_wait", "leased"]),
          ),
        )
        .orderBy(asc(jobs.createdAt), asc(jobs.id))
        .limit(1)
        .get()
      if (
        head === undefined ||
        (head.status === "leased" && (head.leaseUntil === null || head.leaseUntil > input.now)) ||
        head.retryNotBefore > input.now ||
        head.deadlineAt <= input.now
      ) {
        return null
      }
      const claimed = transaction
        .update(jobs)
        .set({
          status: "leased",
          ownerId: input.ownerId,
          leaseGeneration: sql`${jobs.leaseGeneration} + 1`,
          leaseUntil: input.leaseUntil,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(jobs.id, head.id),
            eq(jobs.status, head.status),
            eq(jobs.leaseGeneration, head.leaseGeneration),
            head.status === "leased" ? lte(jobs.leaseUntil, input.now) : undefined,
          ),
        )
        .returning()
        .get()
      if (claimed === undefined) {
        return null
      }
      transaction
        .update(invocations)
        .set({ status: "leased", updatedAt: input.now })
        .where(eq(invocations.id, claimed.invocationId))
        .run()
      return mapJob(claimed, cipher)
    },
    { behavior: "immediate" },
  )
}

export function recordLegacyAttempt(database: ClawbotDatabase, input: RecordAttemptInput): void {
  database.transaction(
    (transaction) => {
      transaction.insert(attempts).values(input).run()
      const job = transaction
        .update(jobs)
        .set({ attemptCount: input.attempt, updatedAt: input.startedAt })
        .where(eq(jobs.id, input.jobId))
        .returning({ invocationId: jobs.invocationId })
        .get()
      if (job !== undefined) {
        transaction
          .update(invocations)
          .set({ attemptCount: input.attempt, updatedAt: input.startedAt })
          .where(eq(invocations.id, job.invocationId))
          .run()
      }
    },
    { behavior: "immediate" },
  )
}

class LegacyQueueError extends Error {
  readonly name = "LegacyQueueError"
}
