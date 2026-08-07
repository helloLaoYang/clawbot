import { Buffer } from "node:buffer"

import { z } from "zod"

import type { BotCredentials, JobRecord } from "../db/contracts"

export const TENCENT_ILINK_ORIGIN = "https://ilinkai.weixin.qq.com" as const
export const TENCENT_API_TIMEOUT_MS = 15_000
export const TENCENT_LONG_POLL_TIMEOUT_MS = 35_000
export const TENCENT_BODY_LIMIT_BYTES = 1_048_576
export const TENCENT_CHANNEL_VERSION = "2.4.6" as const
export const TENCENT_ILINK_APP_ID = "bot" as const
export const TENCENT_ILINK_CLIENT_VERSION = "132102" as const
export const TENCENT_AUTHORIZATION_TYPE = "ilink_bot_token" as const

const DEFAULT_BOT_AGENT = "OpenClaw" as const
const BOT_AGENT_MAX_BYTES = 256
const BOT_AGENT_PRODUCT_PATTERN = /^[A-Za-z0-9_.-]{1,32}\/[A-Za-z0-9_.+-]{1,32}$/
const BOT_AGENT_COMMENT_PATTERN = /^[\x20-\x27\x2A-\x7E]{1,64}$/

export const TENCENT_OPERATIONS = [
  "fetch_qr_code",
  "get_qr_status",
  "get_updates",
  "send_message",
  "notify_start",
  "notify_stop",
] as const
export type TencentOperation = (typeof TENCENT_OPERATIONS)[number]

const QrCodeResponseSchema = z
  .object({
    qrcode: z.string().min(1),
    qrcode_img_content: z.string().min(1),
  })
  .readonly()

const QrStatusSchema = z
  .object({
    status: z.enum([
      "wait",
      "scaned",
      "confirmed",
      "expired",
      "scaned_but_redirect",
      "need_verifycode",
      "verify_code_blocked",
      "binded_redirect",
    ]),
    bot_token: z.string().optional(),
    ilink_bot_id: z.string().optional(),
    baseurl: z.string().optional(),
    ilink_user_id: z.string().optional(),
    redirect_host: z.string().optional(),
  })
  .readonly()

const UpdateMessageSchema = z
  .object({
    from_user_id: z.string().optional(),
    context_token: z.string().optional(),
  })
  .readonly()

const TencentRetFields = {
  ret: z.number().int(),
  errcode: z.number().int().optional(),
  errmsg: z.string().optional(),
}

const GetUpdatesResponseSchema = z
  .object({
    ...TencentRetFields,
    msgs: z.array(UpdateMessageSchema).readonly().default([]),
    get_updates_buf: z.string().optional(),
    longpolling_timeout_ms: z.number().int().nonnegative().optional(),
  })
  .readonly()

const RetResponseSchema = z.object(TencentRetFields).readonly()

export type QrCodeResponse = z.infer<typeof QrCodeResponseSchema>
export type QrStatusResponse = z.infer<typeof QrStatusSchema>
export type GetUpdatesResponse = z.infer<typeof GetUpdatesResponseSchema>
export type RetResponse = z.infer<typeof RetResponseSchema>

export type TencentCredentials = Pick<BotCredentials, "baseUrl" | "botToken">
export type LocalTokenCredential = Pick<BotCredentials, "botToken" | "updatedAt">

export type FetchQrCodeInput = {
  readonly localCredentials: readonly LocalTokenCredential[]
  readonly signal?: AbortSignal
}

export type GetQrStatusInput = {
  readonly baseUrl: string
  readonly qrcode: string
  readonly verifyCode?: string
  readonly signal?: AbortSignal
}

export type GetUpdatesInput = {
  readonly credentials: TencentCredentials
  readonly getUpdatesBuffer: string
  readonly signal?: AbortSignal
}

export type SendMessageInput = Pick<
  JobRecord,
  "clientId" | "recipient" | "text" | "contextToken"
> & {
  readonly credentials: TencentCredentials
  readonly signal?: AbortSignal
}

export type NotifyInput = {
  readonly credentials: TencentCredentials
  readonly signal?: AbortSignal
}

export type SendMessageResult = {
  readonly clientId: string
  readonly messageId: string
}

export const TENCENT_RESPONSE_SCHEMAS = {
  getUpdates: GetUpdatesResponseSchema,
  qrCode: QrCodeResponseSchema,
  qrStatus: QrStatusSchema,
  ret: RetResponseSchema,
} as const

export function sanitizeBotAgent(raw: string | undefined): string {
  const trimmed = raw?.trim()
  if (trimmed === undefined || trimmed === "") {
    return DEFAULT_BOT_AGENT
  }

  const rawTokens = trimmed.split(/\s+/)
  const tokens: string[] = []
  for (let index = 0; index < rawTokens.length; index += 1) {
    const token = rawTokens[index]
    if (token === undefined) {
      continue
    }
    if (token.startsWith("(") && !token.endsWith(")")) {
      let comment = token
      while (index + 1 < rawTokens.length && !comment.endsWith(")")) {
        index += 1
        comment = `${comment} ${rawTokens[index] ?? ""}`
      }
      tokens.push(comment)
    } else {
      tokens.push(token)
    }
  }

  const accepted: string[] = []
  let pendingProduct: string | null = null
  for (const token of tokens) {
    if (token.startsWith("(") && token.endsWith(")")) {
      const comment = token.slice(1, -1)
      if (pendingProduct !== null && BOT_AGENT_COMMENT_PATTERN.test(comment)) {
        accepted.push(`${pendingProduct} (${comment})`)
        pendingProduct = null
        continue
      }
    }
    if (pendingProduct !== null) {
      accepted.push(pendingProduct)
      pendingProduct = null
    }
    if (BOT_AGENT_PRODUCT_PATTERN.test(token)) {
      pendingProduct = token
    }
  }
  if (pendingProduct !== null) {
    accepted.push(pendingProduct)
  }

  const sanitized = accepted.join(" ")
  if (sanitized === "") {
    return DEFAULT_BOT_AGENT
  }
  if (Buffer.byteLength(sanitized, "utf8") <= BOT_AGENT_MAX_BYTES) {
    return sanitized
  }

  const truncated: string[] = []
  let byteLength = 0
  for (const token of accepted) {
    const additionalBytes = (truncated.length === 0 ? 0 : 1) + Buffer.byteLength(token, "utf8")
    if (byteLength + additionalBytes > BOT_AGENT_MAX_BYTES) {
      break
    }
    truncated.push(token)
    byteLength += additionalBytes
  }
  return truncated.length === 0 ? DEFAULT_BOT_AGENT : truncated.join(" ")
}

export function selectLocalTokens(credentials: readonly LocalTokenCredential[]): readonly string[] {
  return [...credentials]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map(({ botToken }) => botToken.trim())
    .filter((botToken) => botToken !== "")
    .slice(0, 10)
}
