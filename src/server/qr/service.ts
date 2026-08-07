import type { AdminSessionId } from "../crypto/admin-auth"
import type { DerivedCryptoKeys } from "../crypto/keys"
import type { BotPublicId } from "../db/ids"
import type { QrBotRepository } from "../db/qr-contracts"
import type { BotRepository } from "../db/repositories/contracts"
import type { TencentIlinkAdapter } from "../tencent/adapter"
import { TencentIlinkError } from "../tencent/errors"
import { canonicalizeTencentBaseUrl } from "../tencent/origin"
import {
  TENCENT_ILINK_ORIGIN,
  type QrStatusResponse as TencentQrStatusResponse,
} from "../tencent/protocol"
import { confirmQrBot } from "./confirmation"
import {
  createBotSummary,
  QR_MAX_REFRESHES,
  type QrResult,
  type QrSessionId,
  type QrStartResponse,
  type QrStatusResponse,
  type QrTarget,
} from "./contracts"
import { type ActiveQrSession, InMemoryQrSessionStore } from "./session-store"

type QrAdapter = Pick<TencentIlinkAdapter, "fetchQrCode" | "getQrStatus">

type QrLimits = Readonly<{
  defaultBotMaxSendsPerMinute: number
  tencentMaxSendsPerMinute: number
}>

type QrServiceOptions = Readonly<{
  adapter: QrAdapter
  bots: BotRepository
  clock: { readonly now: () => number }
  keys: DerivedCryptoKeys
  limits: QrLimits
  qrBots: QrBotRepository
}>

type StartQrInput = Readonly<{
  botPublicId?: BotPublicId
  ownerId: AdminSessionId
}>

type PollQrInput = Readonly<{
  ownerId: AdminSessionId
  sessionId: QrSessionId
}>

type VerifyQrInput = PollQrInput & Readonly<{ verifyCode: string }>

export interface QrOnboardingService {
  start(input: StartQrInput): Promise<QrResult<QrStartResponse>>
  poll(input: PollQrInput): Promise<QrResult<QrStatusResponse>>
  verifyCode(input: VerifyQrInput): Promise<QrResult<QrStatusResponse>>
}

export class InMemoryQrOnboardingService implements QrOnboardingService {
  private readonly sessions = new InMemoryQrSessionStore()

  constructor(private readonly options: QrServiceOptions) {}

  async start(input: StartQrInput): Promise<QrResult<QrStartResponse>> {
    const now = this.options.clock.now()
    const target = this.resolveTarget(input.botPublicId)
    if (target === null) {
      return { kind: "invalid_state" }
    }
    try {
      const qr = await this.options.adapter.fetchQrCode({
        localCredentials: this.options.qrBots.listLocalCredentials(),
      })
      return {
        kind: "ok",
        value: this.sessions.create({
          now,
          ownerId: input.ownerId,
          pollingBaseUrl: TENCENT_ILINK_ORIGIN,
          qr,
          target,
        }),
      }
    } catch (error) {
      return this.mapTencentError(error)
    }
  }

  poll(input: PollQrInput): Promise<QrResult<QrStatusResponse>> {
    return this.performPoll(input)
  }

  verifyCode(input: VerifyQrInput): Promise<QrResult<QrStatusResponse>> {
    return this.performPoll(input, input.verifyCode)
  }

  private async performPoll(
    input: PollQrInput,
    verifyCode?: string,
  ): Promise<QrResult<QrStatusResponse>> {
    const access = this.sessions.access({
      now: this.options.clock.now(),
      ownerId: input.ownerId,
      sessionId: input.sessionId,
    })
    if (access.kind !== "active") {
      return access
    }
    const { session } = access
    if (session.terminal !== null) {
      return { kind: "ok", value: session.terminal }
    }
    if (session.polling) {
      return { kind: "poll_in_progress" }
    }

    session.polling = true
    try {
      const upstream = await this.options.adapter.getQrStatus({
        baseUrl: session.pollingBaseUrl,
        qrcode: session.qrcode,
        ...(verifyCode === undefined ? {} : { verifyCode }),
      })
      return await this.applyStatus(input.sessionId, session, upstream)
    } catch (error) {
      return this.mapTencentError(error)
    } finally {
      session.polling = false
    }
  }

  private async applyStatus(
    sessionId: QrSessionId,
    session: ActiveQrSession,
    upstream: TencentQrStatusResponse,
  ): Promise<QrResult<QrStatusResponse>> {
    switch (upstream.status) {
      case "wait":
      case "scaned":
      case "need_verifycode":
        return {
          kind: "ok",
          value: this.stateResponse(upstream.status, session.qrcodeUrl),
        }
      case "expired":
      case "verify_code_blocked":
        return this.refresh(sessionId, session, upstream.status)
      case "scaned_but_redirect":
        if (upstream.redirect_host === undefined) {
          return { kind: "upstream_failed" }
        }
        session.pollingBaseUrl = canonicalizeTencentBaseUrl({
          operation: "get_qr_status",
          value: `https://${upstream.redirect_host}`,
        })
        return { kind: "ok", value: this.stateResponse(upstream.status, session.qrcodeUrl) }
      case "binded_redirect": {
        const response = this.stateResponse(upstream.status, null)
        session.terminal = response
        return { kind: "ok", value: response }
      }
      case "confirmed": {
        const confirmation = confirmQrBot(
          { now: this.options.clock.now(), response: upstream, target: session.target },
          {
            defaultBotMaxSendsPerMinute: this.options.limits.defaultBotMaxSendsPerMinute,
            keys: this.options.keys,
            qrBots: this.options.qrBots,
          },
        )
        if (confirmation.kind !== "confirmed") {
          return confirmation
        }
        const bot = createBotSummary(confirmation.bot, this.options.limits.tencentMaxSendsPerMinute)
        session.terminal = {
          bot,
          qrcode_url: null,
          requires_verify_code: false,
          status: "confirmed",
          webhook_bearer: null,
        }
        return {
          kind: "ok",
          value: { ...session.terminal, webhook_bearer: confirmation.bearer },
        }
      }
      default:
        return assertNever(upstream.status)
    }
  }

  private async refresh(
    sessionId: QrSessionId,
    session: ActiveQrSession,
    status: "expired" | "verify_code_blocked",
  ): Promise<QrResult<QrStatusResponse>> {
    if (session.refreshes >= QR_MAX_REFRESHES) {
      this.sessions.delete(sessionId)
      return { kind: "expired" }
    }
    const qr = await this.options.adapter.fetchQrCode({
      localCredentials: this.options.qrBots.listLocalCredentials(),
    })
    session.qrcode = qr.qrcode
    session.qrcodeUrl = qr.qrcode_img_content
    session.pollingBaseUrl = TENCENT_ILINK_ORIGIN
    session.refreshes += 1
    return { kind: "ok", value: this.stateResponse(status, session.qrcodeUrl) }
  }

  private stateResponse(
    status: Exclude<QrStatusResponse["status"], "confirmed">,
    qrcodeUrl: string | null,
  ): QrStatusResponse {
    return {
      bot: null,
      qrcode_url: qrcodeUrl,
      requires_verify_code: status === "need_verifycode",
      status,
      webhook_bearer: null,
    }
  }

  private resolveTarget(botPublicId: BotPublicId | undefined): QrTarget | null {
    if (botPublicId === undefined) {
      return { kind: "new" }
    }
    const bot = this.options.bots.findByPublicId(botPublicId)
    return bot === null ? null : { botId: bot.id, kind: "relogin" }
  }

  private mapTencentError(error: unknown): QrResult<never> {
    if (error instanceof TencentIlinkError) {
      return error.details.kind === "timeout" || error.details.kind === "aborted"
        ? { kind: "deadline_exceeded" }
        : { kind: "upstream_failed" }
    }
    throw error
  }
}

export function createQrOnboardingService(options: QrServiceOptions): QrOnboardingService {
  return new InMemoryQrOnboardingService(options)
}

function assertNever(value: never): never {
  return value
}
