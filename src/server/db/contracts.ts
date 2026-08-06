import type {
  AttemptId,
  BatchId,
  BotId,
  BotPublicId,
  ContextId,
  EpochMilliseconds,
  InvocationId,
  JobId,
} from "./ids"

export const BOT_AUTH_STATUSES = ["active", "reauth_required"] as const
export const INVOCATION_ENDPOINTS = ["single", "admin_batch"] as const
export const INVOCATION_STATUSES = [
  "queued",
  "leased",
  "retry_wait",
  "succeeded",
  "partial",
  "failed",
  "deadline_exceeded",
  "cancelled",
] as const
export const JOB_STATUSES = [
  "queued",
  "leased",
  "retry_wait",
  "succeeded",
  "failed",
  "deadline_exceeded",
  "cancelled",
] as const
export const ATTEMPT_CLASSIFICATIONS = [
  "in_flight",
  "success",
  "network",
  "timeout",
  "rate_limited",
  "upstream_http",
  "upstream_protocol",
  "reauth_required",
  "abandoned",
] as const

export type BotAuthStatus = (typeof BOT_AUTH_STATUSES)[number]
export type InvocationEndpoint = (typeof INVOCATION_ENDPOINTS)[number]
export type InvocationStatus = (typeof INVOCATION_STATUSES)[number]
export type JobStatus = (typeof JOB_STATUSES)[number]
export type AttemptClassification = (typeof ATTEMPT_CLASSIFICATIONS)[number]

type FieldLocation =
  | { readonly table: "bots"; readonly rowId: BotId; readonly column: "ilink_bot_id_encrypted" }
  | { readonly table: "bots"; readonly rowId: BotId; readonly column: "ilink_user_id_encrypted" }
  | { readonly table: "bot_secrets"; readonly rowId: BotId; readonly column: "bot_token_encrypted" }
  | {
      readonly table: "conversation_contexts"
      readonly rowId: ContextId
      readonly column: "user_id_encrypted"
    }
  | {
      readonly table: "conversation_contexts"
      readonly rowId: ContextId
      readonly column: "context_token_encrypted"
    }
  | { readonly table: "inbound_state"; readonly rowId: BotId; readonly column: "cursor_encrypted" }
  | { readonly table: "batches"; readonly rowId: BatchId; readonly column: "recipient_encrypted" }
  | { readonly table: "batches"; readonly rowId: BatchId; readonly column: "text_encrypted" }
  | { readonly table: "jobs"; readonly rowId: JobId; readonly column: "recipient_encrypted" }
  | { readonly table: "jobs"; readonly rowId: JobId; readonly column: "text_encrypted" }
  | { readonly table: "jobs"; readonly rowId: JobId; readonly column: "context_token_encrypted" }
  | {
      readonly table: "encryption_sentinel"
      readonly rowId: "1"
      readonly column: "ciphertext"
    }

export type EncryptFieldInput = FieldLocation & { readonly plaintext: string }
export type DecryptFieldInput = FieldLocation & { readonly ciphertext: string }

export interface FieldCipher {
  encrypt(input: EncryptFieldInput): string
  decrypt(input: DecryptFieldInput): string
}

export type CreateBotInput = {
  readonly id: BotId
  readonly publicId: BotPublicId
  readonly accountFingerprint: string
  readonly ilinkBotIdLookupHash: string
  readonly boundUserFingerprint: string | null
  readonly ilinkBotId: string
  readonly ilinkUserId: string
  readonly remark: string
  readonly enabled: boolean
  readonly authStatus: BotAuthStatus
  readonly maxSendsPerMinute: number
  readonly botToken: string
  readonly baseUrl: string
  readonly webhookBearerHash: string
  readonly webhookBearerLastFour: string
  readonly now: EpochMilliseconds
}

export type BotRecord = Omit<
  CreateBotInput,
  | "ilinkBotIdLookupHash"
  | "botToken"
  | "baseUrl"
  | "webhookBearerHash"
  | "webhookBearerLastFour"
  | "now"
> & {
  readonly createdAt: EpochMilliseconds
  readonly updatedAt: EpochMilliseconds
}

export type BotCredentials = {
  readonly botId: BotId
  readonly botToken: string
  readonly baseUrl: string
  readonly webhookBearerHash: string
  readonly webhookBearerLastFour: string
  readonly createdAt: EpochMilliseconds
  readonly updatedAt: EpochMilliseconds
}

export type UpsertContextInput = {
  readonly id: ContextId
  readonly botId: BotId
  readonly userId: string
  readonly userLookupHash: string
  readonly userFingerprint: string
  readonly contextToken: string
  readonly now: EpochMilliseconds
}

export type ConversationContext = Omit<UpsertContextInput, "now"> & {
  readonly createdAt: EpochMilliseconds
  readonly updatedAt: EpochMilliseconds
}

export type InboundStateRecord = {
  readonly botId: BotId
  readonly cursor: string | null
  readonly lastPolledAt: EpochMilliseconds | null
  readonly updatedAt: EpochMilliseconds
}

export type RateStateRecord = {
  readonly botId: BotId
  readonly lastAttemptAt: EpochMilliseconds | null
  readonly nextEligibleAt: EpochMilliseconds
  readonly cooldownUntil: EpochMilliseconds
  readonly consecutiveRateLimits: number
  readonly updatedAt: EpochMilliseconds
}

export type NewInvocation = {
  readonly id: InvocationId
  readonly requestId: InvocationId
  readonly endpoint: InvocationEndpoint
  readonly botId: BotId | null
  readonly idempotencyScope: string | null
  readonly idempotencyKeyHash: string | null
  readonly requestDigest: string | null
  readonly userFingerprint: string
  readonly deadlineAt: EpochMilliseconds
  readonly createdAt: EpochMilliseconds
}

export type NewSingleInvocation = Omit<NewInvocation, "endpoint" | "botId"> & {
  readonly endpoint: "single"
  readonly botId: BotId
}

export type NewJob = {
  readonly id: JobId
  readonly clientId: string
  readonly botId: BotId
  readonly recipient: string
  readonly recipientLookupHash: string
  readonly userFingerprint: string
  readonly text: string
  readonly contextToken: string
  readonly admissionEstimatedAt: EpochMilliseconds
  readonly retryNotBefore: EpochMilliseconds
  readonly deadlineAt: EpochMilliseconds
  readonly createdAt: EpochMilliseconds
}

export type AdmissionInput = {
  readonly invocation: NewSingleInvocation
  readonly job: NewJob
}

export type JobRecord = NewJob & {
  readonly invocationId: InvocationId
  readonly batchId: BatchId | null
  readonly batchOrder: number | null
  readonly status: JobStatus
  readonly ownerId: string | null
  readonly leaseGeneration: number
  readonly leaseUntil: EpochMilliseconds | null
  readonly attemptCount: number
  readonly completedAt: EpochMilliseconds | null
  readonly updatedAt: EpochMilliseconds
}

export type ClaimInput = {
  readonly botId: BotId
  readonly ownerId: string
  readonly now: EpochMilliseconds
  readonly leaseUntil: EpochMilliseconds
}

export type RecordAttemptInput = {
  readonly id: AttemptId
  readonly jobId: JobId
  readonly attempt: number
  readonly classification: "in_flight"
  readonly startedAt: EpochMilliseconds
}

export type ServiceLease = {
  readonly name: "primary"
  readonly ownerId: string
  readonly fencingToken: number
  readonly expiresAt: EpochMilliseconds
  readonly updatedAt: EpochMilliseconds
}

export type AdminLoginState = {
  readonly failedAttempts: number
  readonly windowStartedAt: EpochMilliseconds | null
  readonly lockedUntil: EpochMilliseconds | null
  readonly updatedAt: EpochMilliseconds
}
