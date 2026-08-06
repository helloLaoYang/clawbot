import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

import type {
  AttemptClassification,
  InvocationEndpoint,
  InvocationStatus,
  JobStatus,
} from "../contracts"
import type { AttemptId, BatchId, BotId, EpochMilliseconds, InvocationId, JobId } from "../ids"
import { bots } from "./accounts"
import { encryptedEnvelopeCheck, sha256Check, uuidV4Check } from "./checks"

export const invocations = sqliteTable(
  "invocations",
  {
    id: text("id").$type<InvocationId>().primaryKey(),
    requestId: text("request_id").$type<InvocationId>().notNull(),
    endpoint: text("endpoint").$type<InvocationEndpoint>().notNull(),
    botId: text("bot_id")
      .$type<BotId>()
      .references(() => bots.id, { onDelete: "cascade" }),
    status: text("status").$type<InvocationStatus>().notNull(),
    idempotencyScope: text("idempotency_scope"),
    idempotencyKeyHash: text("idempotency_key_hash"),
    requestDigest: text("request_digest"),
    userFingerprint: text("user_fingerprint").notNull(),
    responseHttpStatus: integer("response_http_status"),
    responseBody: text("response_body"),
    responseRetryAfter: integer("response_retry_after"),
    attemptCount: integer("attempt_count").notNull().default(0),
    deadlineAt: integer("deadline_at").$type<EpochMilliseconds>().notNull(),
    completedAt: integer("completed_at").$type<EpochMilliseconds>(),
    createdAt: integer("created_at").$type<EpochMilliseconds>().notNull(),
    updatedAt: integer("updated_at").$type<EpochMilliseconds>().notNull(),
  },
  (table) => [
    uuidV4Check("invocations_id_uuid_v4", table.id),
    uuidV4Check("invocations_request_id_uuid_v4", table.requestId),
    uniqueIndex("invocations_request_id_unique").on(table.requestId),
    uniqueIndex("invocations_idempotency_unique").on(
      table.idempotencyScope,
      table.idempotencyKeyHash,
    ),
    index("invocations_timeline_idx").on(table.createdAt, table.id),
    index("invocations_bot_timeline_idx").on(table.botId, table.createdAt, table.id),
    check("invocations_endpoint_enum", sql`${table.endpoint} IN ('single', 'admin_batch')`),
    check(
      "invocations_status_enum",
      sql`${table.status} IN (
        'queued', 'leased', 'retry_wait', 'succeeded', 'partial', 'failed',
        'deadline_exceeded', 'cancelled'
      )`,
    ),
    check(
      "invocations_idempotency_complete",
      sql`(${table.idempotencyScope} IS NULL
        AND ${table.idempotencyKeyHash} IS NULL
        AND ${table.requestDigest} IS NULL)
        OR (${table.idempotencyScope} IS NOT NULL
          AND ${table.idempotencyKeyHash} IS NOT NULL
          AND ${table.requestDigest} IS NOT NULL)`,
    ),
    check(
      "invocations_idempotency_hash",
      sql`${table.idempotencyKeyHash} IS NULL OR (
        length(${table.idempotencyKeyHash}) = 64
        AND ${table.idempotencyKeyHash} NOT GLOB '*[^0-9a-f]*'
      )`,
    ),
    check(
      "invocations_request_digest",
      sql`${table.requestDigest} IS NULL OR (
        length(${table.requestDigest}) = 64
        AND ${table.requestDigest} NOT GLOB '*[^0-9a-f]*'
      )`,
    ),
    check("invocations_attempt_count_nonnegative", sql`${table.attemptCount} >= 0`),
    check(
      "invocations_timestamps_nonnegative",
      sql`${table.createdAt} >= 0
        AND ${table.updatedAt} >= ${table.createdAt}
        AND ${table.deadlineAt} >= ${table.createdAt}
        AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})`,
    ),
  ],
)

export const batches = sqliteTable(
  "batches",
  {
    id: text("id").$type<BatchId>().primaryKey(),
    invocationId: text("invocation_id")
      .$type<InvocationId>()
      .notNull()
      .references(() => invocations.id, { onDelete: "cascade" }),
    recipientEncrypted: text("recipient_encrypted").notNull(),
    recipientLookupHash: text("recipient_lookup_hash").notNull(),
    userFingerprint: text("user_fingerprint").notNull(),
    textEncrypted: text("text_encrypted").notNull(),
    createdAt: integer("created_at").$type<EpochMilliseconds>().notNull(),
  },
  (table) => [
    uuidV4Check("batches_id_uuid_v4", table.id),
    uniqueIndex("batches_invocation_unique").on(table.invocationId),
    encryptedEnvelopeCheck("batches_recipient_encrypted", table.recipientEncrypted),
    encryptedEnvelopeCheck("batches_text_encrypted", table.textEncrypted),
    sha256Check("batches_recipient_lookup_sha256", table.recipientLookupHash),
    check("batches_created_nonnegative", sql`${table.createdAt} >= 0`),
  ],
)

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").$type<JobId>().primaryKey(),
    invocationId: text("invocation_id")
      .$type<InvocationId>()
      .notNull()
      .references(() => invocations.id, { onDelete: "cascade" }),
    batchId: text("batch_id")
      .$type<BatchId>()
      .references(() => batches.id, { onDelete: "cascade" }),
    batchOrder: integer("batch_order"),
    botId: text("bot_id")
      .$type<BotId>()
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    status: text("status").$type<JobStatus>().notNull(),
    clientId: text("client_id").notNull(),
    recipientEncrypted: text("recipient_encrypted").notNull(),
    recipientLookupHash: text("recipient_lookup_hash").notNull(),
    userFingerprint: text("user_fingerprint").notNull(),
    textEncrypted: text("text_encrypted").notNull(),
    contextTokenEncrypted: text("context_token_encrypted").notNull(),
    admissionEstimatedAt: integer("admission_estimated_at").$type<EpochMilliseconds>().notNull(),
    retryNotBefore: integer("retry_not_before").$type<EpochMilliseconds>().notNull(),
    ownerId: text("owner_id"),
    leaseGeneration: integer("lease_generation").notNull().default(0),
    leaseUntil: integer("lease_until").$type<EpochMilliseconds>(),
    attemptCount: integer("attempt_count").notNull().default(0),
    deadlineAt: integer("deadline_at").$type<EpochMilliseconds>().notNull(),
    messageId: text("message_id"),
    resultHttpStatus: integer("result_http_status"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    errorRetryable: integer("error_retryable", { mode: "boolean" }),
    completedAt: integer("completed_at").$type<EpochMilliseconds>(),
    createdAt: integer("created_at").$type<EpochMilliseconds>().notNull(),
    updatedAt: integer("updated_at").$type<EpochMilliseconds>().notNull(),
  },
  (table) => [
    uuidV4Check("jobs_id_uuid_v4", table.id),
    uniqueIndex("jobs_client_id_unique").on(table.clientId),
    uniqueIndex("jobs_invocation_bot_unique").on(table.invocationId, table.botId),
    uniqueIndex("jobs_batch_order_unique").on(table.batchId, table.batchOrder),
    index("jobs_bot_fifo_idx").on(table.botId, table.status, table.createdAt, table.id),
    index("jobs_bot_tail_idx").on(
      table.botId,
      table.admissionEstimatedAt,
      table.createdAt,
      table.id,
    ),
    index("jobs_lease_expiry_idx").on(table.status, table.leaseUntil),
    check(
      "jobs_status_enum",
      sql`${table.status} IN (
        'queued', 'leased', 'retry_wait', 'succeeded', 'failed',
        'deadline_exceeded', 'cancelled'
      )`,
    ),
    check(
      "jobs_batch_order_consistent",
      sql`(${table.batchId} IS NULL AND ${table.batchOrder} IS NULL)
        OR (${table.batchId} IS NOT NULL AND ${table.batchOrder} >= 0)`,
    ),
    check(
      "jobs_lease_consistent",
      sql`(${table.status} = 'leased' AND ${table.ownerId} IS NOT NULL AND ${table.leaseUntil} IS NOT NULL)
        OR (${table.status} <> 'leased' AND ${table.ownerId} IS NULL AND ${table.leaseUntil} IS NULL)`,
    ),
    check("jobs_lease_generation_nonnegative", sql`${table.leaseGeneration} >= 0`),
    check("jobs_attempt_count_nonnegative", sql`${table.attemptCount} >= 0`),
    check(
      "jobs_error_retryable_boolean",
      sql`${table.errorRetryable} IS NULL OR ${table.errorRetryable} IN (0, 1)`,
    ),
    encryptedEnvelopeCheck("jobs_recipient_encrypted", table.recipientEncrypted),
    encryptedEnvelopeCheck("jobs_text_encrypted", table.textEncrypted),
    encryptedEnvelopeCheck("jobs_context_token_encrypted", table.contextTokenEncrypted),
    sha256Check("jobs_recipient_lookup_sha256", table.recipientLookupHash),
    check(
      "jobs_timestamps_nonnegative",
      sql`${table.createdAt} >= 0
        AND ${table.updatedAt} >= ${table.createdAt}
        AND ${table.admissionEstimatedAt} >= 0
        AND ${table.retryNotBefore} >= 0
        AND ${table.deadlineAt} >= ${table.createdAt}
        AND (${table.leaseUntil} IS NULL OR ${table.leaseUntil} >= 0)
        AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})`,
    ),
  ],
)

export const attempts = sqliteTable(
  "attempts",
  {
    id: text("id").$type<AttemptId>().primaryKey(),
    jobId: text("job_id")
      .$type<JobId>()
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    classification: text("classification").$type<AttemptClassification>().notNull(),
    httpStatus: integer("http_status"),
    tencentRet: integer("tencent_ret"),
    durationMs: integer("duration_ms"),
    startedAt: integer("started_at").$type<EpochMilliseconds>().notNull(),
    completedAt: integer("completed_at").$type<EpochMilliseconds>(),
  },
  (table) => [
    uuidV4Check("attempts_id_uuid_v4", table.id),
    uniqueIndex("attempts_job_attempt_unique").on(table.jobId, table.attempt),
    index("attempts_job_started_idx").on(table.jobId, table.startedAt),
    check("attempts_attempt_positive", sql`${table.attempt} >= 1`),
    check(
      "attempts_classification_enum",
      sql`${table.classification} IN (
        'in_flight', 'success', 'network', 'timeout', 'rate_limited',
        'upstream_http', 'upstream_protocol', 'reauth_required', 'abandoned'
      )`,
    ),
    check(
      "attempts_completion_consistent",
      sql`(${table.classification} = 'in_flight' AND ${table.completedAt} IS NULL)
        OR (${table.classification} <> 'in_flight' AND ${table.completedAt} IS NOT NULL)`,
    ),
    check(
      "attempts_duration_nonnegative",
      sql`${table.durationMs} IS NULL OR ${table.durationMs} >= 0`,
    ),
    check(
      "attempts_timestamps_nonnegative",
      sql`${table.startedAt} >= 0
        AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.startedAt})`,
    ),
  ],
)
