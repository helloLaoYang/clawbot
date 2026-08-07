import type { BotRecord, CreateBotInput } from "./contracts"
import type { BotId, EpochMilliseconds } from "./ids"

export type LocalQrCredential = Readonly<{
  botToken: string
  updatedAt: EpochMilliseconds
}>

export type ReloginQrBotInput = Readonly<{
  accountFingerprint: string
  baseUrl: string
  botId: BotId
  botToken: string
  boundUserFingerprint: string
  ilinkBotId: string
  ilinkBotIdLookupHash: string
  ilinkUserId: string
  now: EpochMilliseconds
}>

export type ConfirmQrBotInput =
  | { readonly kind: "new"; readonly bot: CreateBotInput }
  | { readonly kind: "relogin"; readonly bot: ReloginQrBotInput }

export type ConfirmQrBotResult =
  | { readonly kind: "confirmed"; readonly bot: BotRecord }
  | { readonly kind: "invalid_state" }

export interface QrBotRepository {
  confirm(input: ConfirmQrBotInput): ConfirmQrBotResult
  listLocalCredentials(): readonly LocalQrCredential[]
}
