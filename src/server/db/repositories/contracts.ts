import type {
  AcquireServiceLeaseInput,
  AdminLoginState,
  BotCredentials,
  BotRecord,
  ConversationContext,
  CreateBotInput,
  InboundStateRecord,
  RateStateRecord,
  RenewServiceLeaseInput,
  ServiceLease,
  UpsertContextInput,
} from "../contracts"
import type { BotId, BotPublicId } from "../ids"

export type { QueueRepository } from "../../queue/contracts"

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

export interface RuntimeRepository {
  getServiceLease(): ServiceLease | null
  acquireServiceLease(input: AcquireServiceLeaseInput): ServiceLease | null
  renewServiceLease(input: RenewServiceLeaseInput): boolean
  getAdminLoginState(): AdminLoginState
  updateAdminLoginState(update: (state: AdminLoginState) => AdminLoginState): AdminLoginState
  saveAdminLoginState(state: AdminLoginState): void
}
