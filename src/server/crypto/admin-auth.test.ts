import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"

import { AdminPasswordHashSchema, SessionSecretSchema } from "../config/config"
import {
  ADMIN_SESSION_TTL_MS,
  createAdminSession,
  verifyAdminPassword,
  verifyAdminSession,
} from "./admin-auth"

const PASSWORD_HASH = AdminPasswordHashSchema.parse(
  "scrypt$v1$32768$8$1$AAECAwQFBgcICQoLDA0ODw$eo40JB24mNWRdcaWU4xBdGepdf_laQaEJfFhiNMVnFg",
)
const SESSION_SECRET = SessionSecretSchema.parse(Buffer.alloc(32, 71).toString("base64"))
const OTHER_SESSION_SECRET = SessionSecretSchema.parse(Buffer.alloc(32, 72).toString("base64"))
const ISSUED_AT = 1_710_000_000_000

describe("administrator password verification", () => {
  it("verifies the exact scrypt v1 password hash", () => {
    // Given: an exact N=32768, r=8, p=1, 32-byte scrypt record.
    // When: the matching password is verified.
    const matches = verifyAdminPassword("correct horse battery staple", PASSWORD_HASH)

    // Then: verification succeeds.
    expect(matches).toBe(true)
  })

  it("rejects a scrypt password mismatch", () => {
    // Given: the same valid stored scrypt record.
    // When: a different password is verified.
    const matches = verifyAdminPassword("incorrect password", PASSWORD_HASH)

    // Then: verification fails.
    expect(matches).toBe(false)
  })
})

describe("signed administrator sessions", () => {
  it("creates an HMAC-SHA-256 session with an eight-hour expiry", () => {
    // Given: a browser-session-only secret and fixed issuance time.
    // When: a session is signed and immediately verified.
    const created = createAdminSession(SESSION_SECRET, ISSUED_AT)
    const verified = verifyAdminSession(created.token, SESSION_SECRET, ISSUED_AT)

    // Then: the authenticated identity and exact TTL are preserved.
    expect(created.expiresAt).toBe(ISSUED_AT + ADMIN_SESSION_TTL_MS)
    expect(verified).toEqual({
      kind: "valid",
      value: {
        expiresAt: ISSUED_AT + ADMIN_SESSION_TTL_MS,
        id: created.id,
        issuedAt: ISSUED_AT,
      },
    })
  })

  it("expires a session at the exact TTL boundary", () => {
    // Given: a valid signed session.
    const created = createAdminSession(SESSION_SECRET, ISSUED_AT)

    // When: it is checked immediately before and at expiry.
    const beforeExpiry = verifyAdminSession(created.token, SESSION_SECRET, created.expiresAt - 1)
    const atExpiry = verifyAdminSession(created.token, SESSION_SECRET, created.expiresAt)

    // Then: the boundary is exclusive.
    expect(beforeExpiry.kind).toBe("valid")
    expect(atExpiry).toEqual({ kind: "invalid", reason: "expired" })
  })

  it("rejects altered and wrong-key sessions with exhaustive outcomes", () => {
    // Given: a valid token, an altered token, and another session secret.
    const created = createAdminSession(SESSION_SECRET, ISSUED_AT)
    const separator = created.token.lastIndexOf(".")
    const signature = Buffer.from(created.token.slice(separator + 1), "base64url")
    signature.set([(signature.at(0) ?? 0) ^ 1], 0)
    const altered = `${created.token.slice(0, separator + 1)}${signature.toString("base64url")}`

    // When: invalid session forms are verified.
    const malformed = verifyAdminSession("not-a-session", SESSION_SECRET, ISSUED_AT)
    const tampered = verifyAdminSession(altered, SESSION_SECRET, ISSUED_AT)
    const wrongKey = verifyAdminSession(created.token, OTHER_SESSION_SECRET, ISSUED_AT)

    // Then: callers receive closed, typed failure variants.
    expect(malformed).toEqual({ kind: "invalid", reason: "malformed" })
    expect(tampered).toEqual({ kind: "invalid", reason: "invalid_signature" })
    expect(wrongKey).toEqual({ kind: "invalid", reason: "invalid_signature" })
  })
})
