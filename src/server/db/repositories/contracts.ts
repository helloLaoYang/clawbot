import type {
  AdminLoginState,
  AdmissionInput,
  BotCredentials,
  BotRecord,
  ClaimInput,
  ConversationContext,
  CreateBotInput,
  InboundStateRecord,
  JobRecord,
  RateStateRecord,
  RecordAttemptInput,
  ServiceLease,
  UpsertContextInput,
} from "../contracts"
import type { BotId, BotPublicId, JobId } from "../ids"

export interface BotRepository {
  create(input: CreateBotInput): BotRecord
  findByPublicId(publicId: BotPublicId): BotRecord | null
  findByUpstreamLookupHash(lookupHash: string): BotRecord | null
  getCredentials(botId: BotId): BotCredentials | null
  delete(botId: BotId): void
}

export interface ConversationRepository {
  upsert(input: UpsertContextInput): ConversationContext
  find(botId: BotId, userLookupHash: string): ConversationContext | null
}

export interface BotStateRepository {
  getInbound(botId: BotId): InboundStateRecord | null
  saveInbound(state: InboundStateRecord): void
  getRate(botId: BotId): RateStateRecord | null
  saveRate(state: RateStateRecord): void
}

export interface QueueRepository {
  admitSingle(input: AdmissionInput): JobRecord
  claimNext(input: ClaimInput): JobRecord | null
  findJob(jobId: JobId): JobRecord | null
  recordAttempt(input: RecordAttemptInput): void
}

export interface RuntimeRepository {
  getServiceLease(): ServiceLease | null
  saveServiceLease(lease: ServiceLease): void
  getAdminLoginState(): AdminLoginState
  saveAdminLoginState(state: AdminLoginState): void
}
