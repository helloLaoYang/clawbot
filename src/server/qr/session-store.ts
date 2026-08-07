import { randomBytes } from "node:crypto"

import type { AdminSessionId } from "../crypto/admin-auth"
import type { QrCodeResponse } from "../tencent/protocol"
import {
  QR_SESSION_TTL_MS,
  type QrFailure,
  QrSessionIdSchema,
  type QrStartResponse,
  type QrStatusResponse,
  type QrTarget,
} from "./contracts"

export type ActiveQrSession = {
  expiresAt: number
  ownerId: AdminSessionId
  polling: boolean
  pollingBaseUrl: string
  qrcode: string
  qrcodeUrl: string
  refreshes: number
  target: QrTarget
  terminal: QrStatusResponse | null
}

type CreateSessionInput = Readonly<{
  now: number
  ownerId: AdminSessionId
  pollingBaseUrl: string
  qr: QrCodeResponse
  target: QrTarget
}>

type AccessSessionInput = Readonly<{
  now: number
  ownerId: AdminSessionId
  sessionId: ReturnType<typeof QrSessionIdSchema.parse>
}>

export type QrSessionAccess =
  | { readonly kind: "active"; readonly session: ActiveQrSession }
  | Extract<QrFailure, { readonly kind: "expired" | "not_found" }>

export class InMemoryQrSessionStore {
  private readonly sessions = new Map<string, ActiveQrSession>()

  create(input: CreateSessionInput): QrStartResponse {
    this.purgeExpired(input.now)
    const sessionId = QrSessionIdSchema.parse(randomBytes(32).toString("base64url"))
    const expiresAt = input.now + QR_SESSION_TTL_MS
    this.sessions.set(sessionId, {
      expiresAt,
      ownerId: input.ownerId,
      polling: false,
      pollingBaseUrl: input.pollingBaseUrl,
      qrcode: input.qr.qrcode,
      qrcodeUrl: input.qr.qrcode_img_content,
      refreshes: 0,
      target: input.target,
      terminal: null,
    })
    return {
      expires_at: expiresAt,
      qrcode_url: input.qr.qrcode_img_content,
      session_id: sessionId,
      status: "wait",
    }
  }

  access(input: AccessSessionInput): QrSessionAccess {
    const session = this.sessions.get(input.sessionId)
    if (session === undefined) {
      return { kind: "expired" }
    }
    if (session.ownerId !== input.ownerId) {
      return { kind: "not_found" }
    }
    if (input.now >= session.expiresAt) {
      this.sessions.delete(input.sessionId)
      return { kind: "expired" }
    }
    return { kind: "active", session }
  }

  delete(sessionId: ReturnType<typeof QrSessionIdSchema.parse>): void {
    this.sessions.delete(sessionId)
  }

  private purgeExpired(now: number): void {
    for (const [sessionId, session] of this.sessions) {
      if (now >= session.expiresAt) {
        this.sessions.delete(sessionId)
      }
    }
  }
}
