import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"

import { AppEncryptionKeySchema } from "../config/config"
import { decodeCursor, encodeCursor } from "./cursor"
import { decryptField, EnvelopeError, encryptField } from "./envelope"
import { deriveCryptoKeys } from "./keys"
import { createAccountFingerprint, createLookupHash, createUserFingerprint } from "./lookup"

const ROOT_KEY = AppEncryptionKeySchema.parse("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=")
const OTHER_ROOT_KEY = AppEncryptionKeySchema.parse("ERERERERERERERERERERERERERERERERERERERERERE=")
const FIELD_CONTEXT = {
  column: "bot_token",
  rowUuid: "123e4567-e89b-42d3-a456-426614174000",
  table: "bot_secrets",
} as const
const POSITION = {
  createdAt: 1_710_000_000_000,
  id: "123e4567-e89b-42d3-a456-426614174000",
} as const
const FIXED_ENVELOPE = "v1.AQEBAQEBAQEBAQEB.Td4pK0MspRzS9VXn.zEW2cq9NRRcGUfq5IymK6w"
const FIXED_CURSOR =
  "MTcxMDAwMDAwMDAwMDoxMjNlNDU2Ny1lODliLTQyZDMtYTQ1Ni00MjY2MTQxNzQwMDA6YTUwY2Q2NmJjOTlmZjg5ZWRkM2NmYjQxYjRmMzY1NDY5NTczZTNmMDUwMDYzMWFiOTc0MTE0NWIwMGZhY2I5Yw"

describe("field encryption", () => {
  it("decrypts the fixed HKDF, AES-GCM, and AAD contract vector", () => {
    // Given: a fixed root key and an independently generated contract envelope.
    const keys = deriveCryptoKeys(ROOT_KEY)

    // When: the field is decrypted with its exact address.
    const plaintext = decryptField(FIXED_ENVELOPE, FIELD_CONTEXT, keys)

    // Then: the authenticated plaintext is recovered.
    expect(plaintext).toBe("secret token")
  })

  it("round-trips UTF-8 plaintext with a fresh nonce", () => {
    // Given: one field value and its authenticated address.
    const keys = deriveCryptoKeys(ROOT_KEY)

    // When: the same value is encrypted twice and decrypted.
    const first = encryptField("token-密文", FIELD_CONTEXT, keys)
    const second = encryptField("token-密文", FIELD_CONTEXT, keys)

    // Then: both decrypt, but randomized envelopes differ.
    expect(decryptField(first, FIELD_CONTEXT, keys)).toBe("token-密文")
    expect(decryptField(second, FIELD_CONTEXT, keys)).toBe("token-密文")
    expect(first).not.toBe(second)
  })

  it("rejects the wrong AAD", () => {
    // Given: a valid encrypted field.
    const keys = deriveCryptoKeys(ROOT_KEY)
    const envelope = encryptField("secret", FIELD_CONTEXT, keys)

    // When: its column address is changed.
    const decrypt = () =>
      decryptField(envelope, { ...FIELD_CONTEXT, column: "context_token" }, keys)

    // Then: authentication fails without returning plaintext.
    expect(decrypt).toThrow(EnvelopeError)
  })

  it("rejects the wrong key", () => {
    // Given: an envelope encrypted under one root key.
    const envelope = encryptField("secret", FIELD_CONTEXT, deriveCryptoKeys(ROOT_KEY))

    // When: another root key attempts decryption.
    const decrypt = () => decryptField(envelope, FIELD_CONTEXT, deriveCryptoKeys(OTHER_ROOT_KEY))

    // Then: authentication fails.
    expect(decrypt).toThrow(EnvelopeError)
  })

  it("rejects an altered authentication tag", () => {
    // Given: a valid envelope with one changed authentication-tag byte.
    const keys = deriveCryptoKeys(ROOT_KEY)
    const tag = Buffer.from("zEW2cq9NRRcGUfq5IymK6w", "base64url")
    tag.set([(tag.at(0) ?? 0) ^ 1], 0)
    const altered = `v1.AQEBAQEBAQEBAQEB.Td4pK0MspRzS9VXn.${tag.toString("base64url")}`

    // When: the altered envelope is decrypted.
    const decrypt = () => decryptField(altered, FIELD_CONTEXT, keys)

    // Then: authentication fails.
    expect(decrypt).toThrow(EnvelopeError)
  })
})

describe("lookup and cursor HMAC domains", () => {
  it("matches the fixed lookup HMAC and fingerprint contract", () => {
    // Given: keys derived from the fixed root key.
    const keys = deriveCryptoKeys(ROOT_KEY)

    // When: an upstream account identifier is hashed and fingerprinted.
    const hash = createLookupHash("wx-account", keys)

    // Then: the full and truncated values match the independent vector.
    expect(hash).toBe("150fb29533e3b21bea4436526315ed3d2688ed4f823b3a2a0567d584feacb321")
    expect(createAccountFingerprint("wx-account", keys)).toBe("acct_150fb295")
    expect(createUserFingerprint("wx-account", keys)).toBe("user_150fb295")
  })

  it("matches and verifies the fixed cursor signing contract", () => {
    // Given: a fixed pagination position and derived cursor key.
    const keys = deriveCryptoKeys(ROOT_KEY)

    // When: the position is signed and decoded.
    const encoded = encodeCursor(POSITION, keys)
    const decoded = decodeCursor(encoded, keys)

    // Then: both the opaque token and verified position match the contract.
    expect(encoded).toBe(FIXED_CURSOR)
    expect(decoded).toEqual({ kind: "valid", value: POSITION })
  })

  it("returns exhaustive invalid outcomes for malformed and tampered cursors", () => {
    // Given: a valid cursor, a malformed value, and a distinct key.
    const keys = deriveCryptoKeys(ROOT_KEY)
    const decoded = Buffer.from(FIXED_CURSOR, "base64url").toString("utf8")
    const alteredPayload = `${decoded.slice(0, -1)}${decoded.endsWith("a") ? "b" : "a"}`
    const altered = Buffer.from(alteredPayload, "utf8").toString("base64url")

    // When: each invalid cursor is decoded.
    const malformed = decodeCursor("not-a-cursor", keys)
    const tampered = decodeCursor(altered, keys)
    const wrongKey = decodeCursor(FIXED_CURSOR, deriveCryptoKeys(OTHER_ROOT_KEY))

    // Then: callers can distinguish shape failures from signature failures.
    expect(malformed).toEqual({ kind: "invalid", reason: "malformed" })
    expect(tampered).toEqual({ kind: "invalid", reason: "invalid_signature" })
    expect(wrongKey).toEqual({ kind: "invalid", reason: "invalid_signature" })
  })
})
