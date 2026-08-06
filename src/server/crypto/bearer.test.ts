import { describe, expect, it } from "vitest"

import { BearerHashSchema } from "../config/config"
import { generateWebhookBearer, hashBearer, verifyBearer } from "./bearer"

describe("webhook bearer credentials", () => {
  it("generates a one-time 32-byte base64url bearer and storage record", () => {
    // Given: the webhook bearer generator.
    // When: a credential is generated.
    const credential = generateWebhookBearer()

    // Then: only its 64-hex hash and last four accompany the 43-character bearer.
    expect(credential.bearer).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(credential.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(credential.lastFour).toBe(credential.bearer.slice(-4))
    expect(credential.hash).toBe(hashBearer(credential.bearer))
  })

  it("compares bearer hashes without depending on candidate length", () => {
    // Given: one stored SHA-256 bearer hash.
    const bearer = "A".repeat(43)
    const storedHash = BearerHashSchema.parse(hashBearer(bearer))

    // When: matching and differently sized candidates are verified.
    const matching = verifyBearer(bearer, storedHash)
    const shortMismatch = verifyBearer("A", storedHash)
    const longMismatch = verifyBearer(`${bearer}extra`, storedHash)

    // Then: only the original UTF-8 bearer matches.
    expect(matching).toBe(true)
    expect(shortMismatch).toBe(false)
    expect(longMismatch).toBe(false)
  })
})
