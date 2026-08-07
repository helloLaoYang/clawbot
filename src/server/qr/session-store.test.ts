// @vitest-environment node

import { Buffer } from "node:buffer"

import { describe, expect, it } from "vitest"

import { SessionSecretSchema } from "../config/config"
import { createAdminSession } from "../crypto/admin-auth"
import { QR_SESSION_TTL_MS } from "./contracts"
import { InMemoryQrSessionStore } from "./session-store"

const NOW = 1_820_000_000_000
const SESSION_SECRET = SessionSecretSchema.parse(Buffer.alloc(32, 97).toString("base64"))

describe("in-memory QR session store", () => {
  it("binds a 32-byte session ID to its owner until the exact five-minute TTL", () => {
    // Given: two signed administrator identities and one fresh QR response.
    const owner = createAdminSession(SESSION_SECRET, NOW)
    const other = createAdminSession(SESSION_SECRET, NOW + 1)
    const store = new InMemoryQrSessionStore()
    const started = store.create({
      now: NOW,
      ownerId: owner.id,
      pollingBaseUrl: "https://ilinkai.weixin.qq.com",
      qr: { qrcode: "secret", qrcode_img_content: "https://weixin.qq.com/x/qr" },
      target: { kind: "new" },
    })

    // When: a foreign owner accesses it, then the owner reaches the exact expiry.
    const foreign = store.access({
      now: NOW,
      ownerId: other.id,
      sessionId: started.session_id,
    })
    const expired = store.access({
      now: NOW + QR_SESSION_TTL_MS,
      ownerId: owner.id,
      sessionId: started.session_id,
    })

    // Then: ownership is concealed, expiry is inclusive, and the ID is 32-byte base64url.
    expect(started.session_id).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(foreign).toEqual({ kind: "not_found" })
    expect(expired).toEqual({ kind: "expired" })
  })
})
