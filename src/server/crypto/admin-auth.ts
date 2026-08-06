import { Buffer } from "node:buffer"
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import { z } from "zod"

import type { AdminPasswordHash, SessionSecret } from "../config/config"
import { decodeCanonicalBase64Url, encodeBase64Url } from "./encoding"

const SESSION_PAYLOAD_PATTERN = /^v1:([A-Za-z0-9_-]{43}):([0-9]+):([0-9]+)$/
const AdminSessionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .brand("AdminSessionId")
const AdminSessionTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/)
  .brand("AdminSessionToken")

export const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1_000

export type AdminSessionId = z.infer<typeof AdminSessionIdSchema>
export type AdminSessionToken = z.infer<typeof AdminSessionTokenSchema>
export type CreatedAdminSession = Readonly<{
  expiresAt: number
  id: AdminSessionId
  token: AdminSessionToken
}>
export type VerifiedAdminSession = Readonly<{
  expiresAt: number
  id: AdminSessionId
  issuedAt: number
}>
export type AdminSessionVerification =
  | {
      readonly kind: "invalid"
      readonly reason: "expired" | "invalid_signature" | "malformed"
    }
  | { readonly kind: "valid"; readonly value: VerifiedAdminSession }

const SCRYPT_OPTIONS = {
  N: 32_768,
  maxmem: 64 * 1_024 * 1_024,
  p: 1,
  r: 8,
} as const

function signSession(payload: string, secret: SessionSecret): Buffer {
  return createHmac("sha256", Buffer.from(secret, "base64")).update(payload, "utf8").digest()
}

export function verifyAdminPassword(password: string, encodedHash: AdminPasswordHash): boolean {
  const segments = encodedHash.split("$")
  const saltValue = segments.at(5)
  const expectedValue = segments.at(6)
  if (saltValue === undefined || expectedValue === undefined) {
    return false
  }

  const salt = Buffer.from(saltValue, "base64url")
  const expected = Buffer.from(expectedValue, "base64url")
  const actual = scryptSync(Buffer.from(password, "utf8"), salt, 32, SCRYPT_OPTIONS)
  return timingSafeEqual(actual, expected)
}

export function createAdminSession(
  secret: SessionSecret,
  issuedAt: number = Date.now(),
): CreatedAdminSession {
  const id = AdminSessionIdSchema.parse(randomBytes(32).toString("base64url"))
  const expiresAt = issuedAt + ADMIN_SESSION_TTL_MS
  const payload = encodeBase64Url(`v1:${id}:${issuedAt}:${expiresAt}`)
  const signature = encodeBase64Url(signSession(payload, secret))
  return Object.freeze({
    expiresAt,
    id,
    token: AdminSessionTokenSchema.parse(`${payload}.${signature}`),
  })
}

export function verifyAdminSession(
  token: string,
  secret: SessionSecret,
  now: number = Date.now(),
): AdminSessionVerification {
  const [payload, suppliedSignatureValue, extra] = token.split(".")
  if (payload === undefined || suppliedSignatureValue === undefined || extra !== undefined) {
    return { kind: "invalid", reason: "malformed" }
  }

  const payloadBytes = decodeCanonicalBase64Url(payload)
  const suppliedSignature = decodeCanonicalBase64Url(suppliedSignatureValue, 32)
  if (payloadBytes === null || suppliedSignature === null) {
    return { kind: "invalid", reason: "malformed" }
  }
  if (!timingSafeEqual(signSession(payload, secret), suppliedSignature)) {
    return { kind: "invalid", reason: "invalid_signature" }
  }

  const match = SESSION_PAYLOAD_PATTERN.exec(payloadBytes.toString("utf8"))
  const idValue = match?.at(1)
  const issuedAtValue = match?.at(2)
  const expiresAtValue = match?.at(3)
  if (idValue === undefined || issuedAtValue === undefined || expiresAtValue === undefined) {
    return { kind: "invalid", reason: "malformed" }
  }

  const issuedAt = Number(issuedAtValue)
  const expiresAt = Number(expiresAtValue)
  const id = AdminSessionIdSchema.safeParse(idValue)
  if (
    !id.success ||
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    String(issuedAt) !== issuedAtValue ||
    String(expiresAt) !== expiresAtValue ||
    expiresAt - issuedAt !== ADMIN_SESSION_TTL_MS
  ) {
    return { kind: "invalid", reason: "malformed" }
  }
  if (expiresAt <= now) {
    return { kind: "invalid", reason: "expired" }
  }

  return { kind: "valid", value: { expiresAt, id: id.data, issuedAt } }
}
