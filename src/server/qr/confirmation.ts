import { randomUUID } from "node:crypto"

import { generateWebhookBearer, type WebhookBearer } from "../crypto/bearer"
import type { DerivedCryptoKeys } from "../crypto/keys"
import { createAccountFingerprint, createLookupHash, createUserFingerprint } from "../crypto/lookup"
import type { BotRecord } from "../db/contracts"
import { BotIdSchema, BotPublicIdSchema, EpochMillisecondsSchema } from "../db/ids"
import type { QrBotRepository } from "../db/qr-contracts"
import type { QrStatusResponse as TencentQrStatusResponse } from "../tencent/protocol"
import type { QrTarget } from "./contracts"

type ConfirmationOptions = Readonly<{
  defaultBotMaxSendsPerMinute: number
  keys: DerivedCryptoKeys
  qrBots: QrBotRepository
}>

type ConfirmQrInput = Readonly<{
  now: number
  response: TencentQrStatusResponse
  target: QrTarget
}>

export type ConfirmationResult =
  | { readonly kind: "confirmed"; readonly bot: BotRecord; readonly bearer: WebhookBearer | null }
  | { readonly kind: "invalid_state" }
  | { readonly kind: "upstream_failed" }

type ConfirmedCredentials = Readonly<{
  baseUrl: string
  botToken: string
  ilinkBotId: string
  ilinkUserId: string
}>

function readConfirmedCredentials(response: TencentQrStatusResponse): ConfirmedCredentials | null {
  const {
    baseurl,
    bot_token: botToken,
    ilink_bot_id: ilinkBotId,
    ilink_user_id: ilinkUserId,
  } = response
  if (
    baseurl === undefined ||
    baseurl === "" ||
    botToken === undefined ||
    botToken === "" ||
    ilinkBotId === undefined ||
    ilinkBotId === "" ||
    ilinkUserId === undefined ||
    ilinkUserId === ""
  ) {
    return null
  }
  return { baseUrl: baseurl, botToken, ilinkBotId, ilinkUserId }
}

export function confirmQrBot(
  input: ConfirmQrInput,
  options: ConfirmationOptions,
): ConfirmationResult {
  const credentials = readConfirmedCredentials(input.response)
  if (credentials === null) {
    return { kind: "upstream_failed" }
  }
  const now = EpochMillisecondsSchema.parse(input.now)
  const identity = {
    accountFingerprint: createAccountFingerprint(credentials.ilinkBotId, options.keys),
    boundUserFingerprint: createUserFingerprint(credentials.ilinkUserId, options.keys),
    ilinkBotIdLookupHash: createLookupHash(credentials.ilinkBotId, options.keys),
  }

  switch (input.target.kind) {
    case "new": {
      const webhook = generateWebhookBearer()
      const result = options.qrBots.confirm({
        kind: "new",
        bot: {
          ...identity,
          authStatus: "active",
          baseUrl: credentials.baseUrl,
          botToken: credentials.botToken,
          enabled: true,
          id: BotIdSchema.parse(randomUUID()),
          ilinkBotId: credentials.ilinkBotId,
          ilinkUserId: credentials.ilinkUserId,
          maxSendsPerMinute: options.defaultBotMaxSendsPerMinute,
          now,
          publicId: BotPublicIdSchema.parse(randomUUID()),
          remark: "",
          webhookBearerHash: webhook.hash,
          webhookBearerLastFour: webhook.lastFour,
        },
      })
      return result.kind === "invalid_state"
        ? result
        : { bearer: webhook.bearer, bot: result.bot, kind: "confirmed" }
    }
    case "relogin": {
      const result = options.qrBots.confirm({
        kind: "relogin",
        bot: {
          ...identity,
          baseUrl: credentials.baseUrl,
          botId: input.target.botId,
          botToken: credentials.botToken,
          ilinkBotId: credentials.ilinkBotId,
          ilinkUserId: credentials.ilinkUserId,
          now,
        },
      })
      return result.kind === "invalid_state"
        ? result
        : { bearer: null, bot: result.bot, kind: "confirmed" }
    }
    default:
      return assertNever(input.target)
  }
}

function assertNever(value: never): never {
  return value
}
