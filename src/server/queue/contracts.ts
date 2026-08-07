import type { AdmissionInput, ClaimInput, JobRecord, RecordAttemptInput } from "../db/contracts"
import type { AttemptId, BotId, EpochMilliseconds, InvocationId, JobId } from "../db/ids"

export const JOB_DEADLINE_MS = 60_000
export const JOB_LEASE_MS = 30_000
export const JOB_LEASE_RENEWAL_MS = 5_000
export const MINIMUM_ATTEMPT_BUDGET_MS = 15_000
export const MAX_NONTERMINAL_JOBS = 100
export const IDEMPOTENCY_TTL_MS = 86_400_000

export interface QueueClock {
  now(): EpochMilliseconds
}

export type ServiceFence = {
  readonly ownerId: string
  readonly fencingToken: number
}

export type SingleAdmissionCommand = {
  readonly invocationId: InvocationId
  readonly requestId: InvocationId
  readonly jobId: JobId
  readonly botId: BotId
  readonly recipient: string
  readonly recipientLookupHash: string
  readonly userFingerprint: string
  readonly text: string
  readonly contextToken: string
  readonly idempotencyKey: string | null
  readonly currentCeiling: number
}

export type StoredResponse = {
  readonly httpStatus: number
  readonly body: string
  readonly retryAfter: number | null
}

export type AdmissionResult =
  | { readonly kind: "admitted"; readonly job: JobRecord }
  | {
      readonly kind: "replayed_in_flight"
      readonly invocationId: InvocationId
      readonly jobId: JobId
      readonly deadlineAt: EpochMilliseconds
    }
  | {
      readonly kind: "replayed_terminal"
      readonly invocationId: InvocationId
      readonly jobId: JobId
      readonly response: StoredResponse
    }
  | { readonly kind: "idempotency_conflict"; readonly invocationId: InvocationId }
  | { readonly kind: "queue_full"; readonly retryAfter: number }
  | {
      readonly kind: "deadline_unavailable"
      readonly estimatedAt: EpochMilliseconds
      readonly retryAfter: number
    }

export type ClaimCommand = {
  readonly botId: BotId
  readonly ownerId: string
  readonly serviceFence: ServiceFence
}

export type ClaimResult =
  | { readonly kind: "claimed"; readonly job: JobRecord }
  | { readonly kind: "blocked" }
  | { readonly kind: "service_fence_lost" }

export type JobLeaseIdentity = {
  readonly jobId: JobId
  readonly ownerId: string
  readonly leaseGeneration: number
  readonly serviceFence: ServiceFence
}

export type PrepareAttemptCommand = JobLeaseIdentity & {
  readonly currentCeiling: number
}

type AttemptTiming = {
  readonly intervalMs: number
  readonly eligibleAt: EpochMilliseconds
}

export type PrepareAttemptResult =
  | (AttemptTiming & {
      readonly kind: "started"
      readonly attemptId: AttemptId
      readonly attempt: number
    })
  | (AttemptTiming & { readonly kind: "deferred" })
  | (AttemptTiming & {
      readonly kind: "terminal"
      readonly httpStatus: 429 | 504
      readonly retryAfter: number | null
    })
  | { readonly kind: "lease_lost" }
  | { readonly kind: "service_fence_lost" }

export type RenewLeaseCommand = JobLeaseIdentity & {
  readonly abortController: AbortController
}

export type FailureClassification =
  | "network"
  | "timeout"
  | "rate_limited"
  | "upstream_http"
  | "upstream_protocol"
  | "reauth_required"

export type RecordFailureCommand = JobLeaseIdentity & {
  readonly attempt: number
  readonly classification: FailureClassification
  readonly httpStatus: number | null
  readonly tencentRet: number | null
  readonly backoffMs: number
  readonly retryAfter: string | null
}

export type RecordFailureResult =
  | {
      readonly kind: "recorded"
      readonly retryNotBefore: EpochMilliseconds
      readonly cooldownUntil: EpochMilliseconds
      readonly consecutiveRateLimits: number
    }
  | { readonly kind: "lease_lost" }
  | { readonly kind: "service_fence_lost" }

export type FinalizeSuccessCommand = JobLeaseIdentity & {
  readonly attempt: number
  readonly messageId: string
  readonly responseHttpStatus: 200
  readonly responseBody: string
  readonly responseRetryAfter: number | null
}

export interface QueueRepository {
  admitSingle(input: AdmissionInput): JobRecord
  claimNext(input: ClaimInput): JobRecord | null
  findJob(jobId: JobId): JobRecord | null
  recordAttempt(input: RecordAttemptInput): void
  admit(input: SingleAdmissionCommand): AdmissionResult
  claim(input: ClaimCommand): ClaimResult
  prepareAttempt(input: PrepareAttemptCommand): PrepareAttemptResult
  renewLease(input: RenewLeaseCommand): boolean
  recordFailure(input: RecordFailureCommand): RecordFailureResult
  finalizeSuccess(input: FinalizeSuccessCommand): boolean
}
