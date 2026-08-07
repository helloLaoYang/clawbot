import { z } from "zod"

import type { WebhookBearer } from "../crypto/bearer"
import type { BotRecord } from "../db/contracts"
import { type BotId, BotPublicIdSchema } from "../db/ids"

export const QR_SESSION_TTL_MS = 5 * 60 * 1_000
export const QR_MAX_REFRESHES = 3

export const QR_STATUSES = [
  "wait",
  "scaned",
  "need_verifycode",
  "verify_code_blocked",
  "expired",
  "scaned_but_redirect",
  "binded_redirect",
  "confirmed",
] as const

export const QrSessionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .brand("QrSessionId")
export const StartQrSessionRequestSchema = z
  .object({ bot_public_id: BotPublicIdSchema.optional() })
  .strict()
  .readonly()
export const VerifyQrCodeRequestSchema = z
  .object({ verify_code: z.string().regex(/^[0-9]{1,12}$/) })
  .strict()
  .readonly()

export type QrSessionId = z.infer<typeof QrSessionIdSchema>
export type QrStatus = (typeof QR_STATUSES)[number]
export type QrTarget =
  | { readonly kind: "new" }
  | { readonly botId: BotId; readonly kind: "relogin" }

export type BotSummary = Readonly<{
  account_fingerprint: string
  auth_status: "active" | "reauth_required"
  bound_user_fingerprint: string | null
  configured_max_sends_per_minute: number
  created_at: number
  effective_max_sends_per_minute: number
  enabled: boolean
  public_id: string
  remark: string
  updated_at: number
}>

export type QrStartResponse = Readonly<{
  expires_at: number
  qrcode_url: string
  session_id: QrSessionId
  status: "wait"
}>

export type QrStatusResponse = Readonly<{
  bot: BotSummary | null
  qrcode_url: string | null
  requires_verify_code: boolean
  status: QrStatus
  webhook_bearer: WebhookBearer | null
}>

export type QrFailure =
  | { readonly kind: "deadline_exceeded" }
  | { readonly kind: "expired" }
  | { readonly kind: "invalid_state" }
  | { readonly kind: "not_found" }
  | { readonly kind: "poll_in_progress" }
  | { readonly kind: "upstream_failed" }

export type QrResult<T> = { readonly kind: "ok"; readonly value: T } | QrFailure

export function createBotSummary(bot: BotRecord, tencentMaxSendsPerMinute: number): BotSummary {
  return {
    account_fingerprint: bot.accountFingerprint,
    auth_status: bot.authStatus,
    bound_user_fingerprint: bot.boundUserFingerprint,
    configured_max_sends_per_minute: bot.maxSendsPerMinute,
    created_at: bot.createdAt,
    effective_max_sends_per_minute: Math.min(bot.maxSendsPerMinute, tencentMaxSendsPerMinute),
    enabled: bot.enabled,
    public_id: bot.publicId,
    remark: bot.remark,
    updated_at: bot.updatedAt,
  }
}
