// @vitest-environment node

import { describe, expect, it } from "vitest"

import type { QrStatusResponse as TencentQrStatusResponse } from "../tencent/protocol"
import { confirmedStatus, createQrHarness, startQrSession } from "./test-support"

const CASES = [
  { expectedBearer: false, expectedBot: false, requiresCode: false, upstream: { status: "wait" } },
  {
    expectedBearer: false,
    expectedBot: false,
    requiresCode: false,
    upstream: { status: "scaned" },
  },
  {
    expectedBearer: false,
    expectedBot: false,
    requiresCode: true,
    upstream: { status: "need_verifycode" },
  },
  {
    expectedBearer: false,
    expectedBot: false,
    requiresCode: false,
    upstream: { status: "verify_code_blocked" },
  },
  {
    expectedBearer: false,
    expectedBot: false,
    requiresCode: false,
    upstream: { status: "expired" },
  },
  {
    expectedBearer: false,
    expectedBot: false,
    requiresCode: false,
    upstream: { status: "scaned_but_redirect", redirect_host: "shard.weixin.qq.com" },
  },
  {
    expectedBearer: false,
    expectedBot: false,
    requiresCode: false,
    upstream: { status: "binded_redirect" },
  },
  {
    expectedBearer: true,
    expectedBot: true,
    requiresCode: false,
    upstream: confirmedStatus,
  },
] as const satisfies readonly {
  readonly expectedBearer: boolean
  readonly expectedBot: boolean
  readonly requiresCode: boolean
  readonly upstream: TencentQrStatusResponse
}[]

const STATUS_RESPONSE_KEYS = [
  "bot",
  "qrcode_url",
  "requires_verify_code",
  "status",
  "webhook_bearer",
] as const

describe("QR onboarding upstream states", () => {
  it.each(CASES)("maps $upstream.status to the exact public response", async (testCase) => {
    // Given: an authenticated administrator QR session and one upstream v2.4.6 state.
    const harness = createQrHarness(`task-7-state-${testCase.upstream.status}`, [testCase.upstream])

    try {
      const started = await startQrSession(harness)

      // When: the state machine performs one long poll.
      const result = await harness.service.poll({
        ownerId: harness.ownerId,
        sessionId: started.session_id,
      })

      // Then: the state and byte-shape contract are preserved without unrelated fields.
      expect(result.kind).toBe("ok")
      if (result.kind !== "ok") {
        return
      }
      expect(Object.keys(result.value).sort()).toEqual([...STATUS_RESPONSE_KEYS])
      expect(result.value.status).toBe(testCase.upstream.status)
      expect(result.value.requires_verify_code).toBe(testCase.requiresCode)
      expect(result.value.bot === null).toBe(!testCase.expectedBot)
      expect(result.value.webhook_bearer === null).toBe(!testCase.expectedBearer)
      if (result.value.bot !== null) {
        expect(Object.keys(result.value.bot).sort()).toEqual([
          "account_fingerprint",
          "auth_status",
          "bound_user_fingerprint",
          "configured_max_sends_per_minute",
          "created_at",
          "effective_max_sends_per_minute",
          "enabled",
          "public_id",
          "remark",
          "updated_at",
        ])
      }
    } finally {
      harness.cleanup()
    }
  })
})
