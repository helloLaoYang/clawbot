import { and, asc, eq, inArray, lte, sql } from "drizzle-orm"

import type {
  AdmissionInput,
  ClaimInput,
  FieldCipher,
  JobRecord,
  RecordAttemptInput,
} from "../contracts"
import type { JobId } from "../ids"
import { attempts, invocations, jobs } from "../schema"
import type { ClawbotDatabase } from "../types"
import type { QueueRepository } from "./contracts"

export class DrizzleQueueRepository implements QueueRepository {
  constructor(
    private readonly database: ClawbotDatabase,
    private readonly cipher: FieldCipher,
  ) {}

  admitSingle(input: AdmissionInput): JobRecord {
    return this.database.transaction(
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
        transaction
          .insert(jobs)
          .values({
            id: input.job.id,
            invocationId: input.invocation.id,
            botId: input.job.botId,
            status: "queued",
            clientId: input.job.clientId,
            recipientEncrypted: this.cipher.encrypt({
              table: "jobs",
              rowId: input.job.id,
              column: "recipient_encrypted",
              plaintext: input.job.recipient,
            }),
            recipientLookupHash: input.job.recipientLookupHash,
            userFingerprint: input.job.userFingerprint,
            textEncrypted: this.cipher.encrypt({
              table: "jobs",
              rowId: input.job.id,
              column: "text_encrypted",
              plaintext: input.job.text,
            }),
            contextTokenEncrypted: this.cipher.encrypt({
              table: "jobs",
              rowId: input.job.id,
              column: "context_token_encrypted",
              plaintext: input.job.contextToken,
            }),
            admissionEstimatedAt: input.job.admissionEstimatedAt,
            retryNotBefore: input.job.retryNotBefore,
            deadlineAt: input.job.deadlineAt,
            createdAt: input.job.createdAt,
            updatedAt: input.job.createdAt,
          })
          .run()
        return {
          ...input.job,
          invocationId: input.invocation.id,
          batchId: null,
          batchOrder: null,
          status: "queued",
          ownerId: null,
          leaseGeneration: 0,
          leaseUntil: null,
          attemptCount: 0,
          completedAt: null,
          updatedAt: input.job.createdAt,
        }
      },
      { behavior: "immediate" },
    )
  }

  claimNext(input: ClaimInput): JobRecord | null {
    return this.database.transaction(
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
        return this.mapJob(claimed)
      },
      { behavior: "immediate" },
    )
  }

  findJob(jobId: JobId): JobRecord | null {
    const row = this.database.select().from(jobs).where(eq(jobs.id, jobId)).get()
    return row === undefined ? null : this.mapJob(row)
  }

  recordAttempt(input: RecordAttemptInput): void {
    this.database.transaction(
      (transaction) => {
        transaction
          .insert(attempts)
          .values({
            id: input.id,
            jobId: input.jobId,
            attempt: input.attempt,
            classification: input.classification,
            startedAt: input.startedAt,
          })
          .run()
        const job = transaction
          .update(jobs)
          .set({
            attemptCount: input.attempt,
            updatedAt: input.startedAt,
          })
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

  private mapJob(row: typeof jobs.$inferSelect): JobRecord {
    return {
      id: row.id,
      invocationId: row.invocationId,
      batchId: row.batchId,
      batchOrder: row.batchOrder,
      botId: row.botId,
      status: row.status,
      clientId: row.clientId,
      recipient: this.cipher.decrypt({
        table: "jobs",
        rowId: row.id,
        column: "recipient_encrypted",
        ciphertext: row.recipientEncrypted,
      }),
      recipientLookupHash: row.recipientLookupHash,
      userFingerprint: row.userFingerprint,
      text: this.cipher.decrypt({
        table: "jobs",
        rowId: row.id,
        column: "text_encrypted",
        ciphertext: row.textEncrypted,
      }),
      contextToken: this.cipher.decrypt({
        table: "jobs",
        rowId: row.id,
        column: "context_token_encrypted",
        ciphertext: row.contextTokenEncrypted,
      }),
      admissionEstimatedAt: row.admissionEstimatedAt,
      retryNotBefore: row.retryNotBefore,
      ownerId: row.ownerId,
      leaseGeneration: row.leaseGeneration,
      leaseUntil: row.leaseUntil,
      attemptCount: row.attemptCount,
      deadlineAt: row.deadlineAt,
      completedAt: row.completedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }
}
