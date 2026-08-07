import type { FieldCipher, JobRecord } from "../db/contracts"
import type { JobId } from "../db/ids"
import type { jobs } from "../db/schema"

export function mapJob(row: typeof jobs.$inferSelect, cipher: FieldCipher): JobRecord {
  return {
    id: row.id,
    invocationId: row.invocationId,
    batchId: row.batchId,
    batchOrder: row.batchOrder,
    botId: row.botId,
    status: row.status,
    clientId: row.clientId,
    recipient: cipher.decrypt({
      table: "jobs",
      rowId: row.id,
      column: "recipient_encrypted",
      ciphertext: row.recipientEncrypted,
    }),
    recipientLookupHash: row.recipientLookupHash,
    userFingerprint: row.userFingerprint,
    text: cipher.decrypt({
      table: "jobs",
      rowId: row.id,
      column: "text_encrypted",
      ciphertext: row.textEncrypted,
    }),
    contextToken: cipher.decrypt({
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

export function encryptJobFields(
  cipher: FieldCipher,
  input: {
    readonly jobId: JobId
    readonly recipient: string
    readonly text: string
    readonly contextToken: string
  },
): {
  readonly recipientEncrypted: string
  readonly textEncrypted: string
  readonly contextTokenEncrypted: string
} {
  return {
    recipientEncrypted: cipher.encrypt({
      table: "jobs",
      rowId: input.jobId,
      column: "recipient_encrypted",
      plaintext: input.recipient,
    }),
    textEncrypted: cipher.encrypt({
      table: "jobs",
      rowId: input.jobId,
      column: "text_encrypted",
      plaintext: input.text,
    }),
    contextTokenEncrypted: cipher.encrypt({
      table: "jobs",
      rowId: input.jobId,
      column: "context_token_encrypted",
      plaintext: input.contextToken,
    }),
  }
}
