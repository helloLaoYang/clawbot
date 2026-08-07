// @vitest-environment node

import { describe, expect, it } from "vitest"

import type { QrStatusResponse as TencentQrStatusResponse } from "../tencent/protocol"
import { QR_SESSION_TTL_MS } from "./contracts"
import { confirmedStatus, createQrHarness, deferredQrStatus, startQrSession } from "./test-support"

class QrSecurityFixtureError extends Error {
  readonly name = "QrSecurityFixtureError"
}

function withoutConfirmedField(
  missingField: "baseurl" | "bot_token" | "ilink_bot_id" | "ilink_user_id",
): TencentQrStatusResponse {
  switch (missingField) {
    case "baseurl":
      return {
        status: "confirmed",
        bot_token: confirmedStatus.bot_token,
        ilink_bot_id: confirmedStatus.ilink_bot_id,
        ilink_user_id: confirmedStatus.ilink_user_id,
      }
    case "bot_token":
      return {
        status: "confirmed",
        baseurl: confirmedStatus.baseurl,
        ilink_bot_id: confirmedStatus.ilink_bot_id,
        ilink_user_id: confirmedStatus.ilink_user_id,
      }
    case "ilink_bot_id":
      return {
        status: "confirmed",
        baseurl: confirmedStatus.baseurl,
        bot_token: confirmedStatus.bot_token,
        ilink_user_id: confirmedStatus.ilink_user_id,
      }
    case "ilink_user_id":
      return {
        status: "confirmed",
        baseurl: confirmedStatus.baseurl,
        bot_token: confirmedStatus.bot_token,
        ilink_bot_id: confirmedStatus.ilink_bot_id,
      }
    default:
      throw new QrSecurityFixtureError(`unhandled confirmed field: ${missingField}`)
  }
}

describe("QR onboarding session security", () => {
  it("binds a QR session to the administrator session that created it", async () => {
    // Given: one QR session owned by the first signed administrator session.
    const harness = createQrHarness("task-7-owner", [{ status: "wait" }])

    try {
      const started = await startQrSession(harness)

      // When: a different valid administrator session tries to poll it.
      const result = await harness.service.poll({
        ownerId: harness.otherOwnerId,
        sessionId: started.session_id,
      })

      // Then: ownership is concealed as not-found before contacting Tencent.
      expect(result).toEqual({ kind: "not_found" })
      expect(harness.adapter.pollInputs).toHaveLength(0)
    } finally {
      harness.cleanup()
    }
  })

  it("expires at five minutes and treats an in-memory session as gone after restart", async () => {
    // Given: one started QR session and a fresh service over the same durable database.
    const harness = createQrHarness("task-7-ttl-restart", [{ status: "wait" }])

    try {
      const started = await startQrSession(harness)
      const restarted = harness.restart()

      // When: the old process identity is polled and the original reaches its exact TTL.
      const afterRestart = await restarted.poll({
        ownerId: harness.ownerId,
        sessionId: started.session_id,
      })
      harness.setNow(started.expires_at)
      const atExpiry = await harness.service.poll({
        ownerId: harness.ownerId,
        sessionId: started.session_id,
      })

      // Then: both are expired, and the fixed TTL is exactly five minutes.
      expect(started.expires_at).toBe(1_820_000_000_000 + QR_SESSION_TTL_MS)
      expect(afterRestart).toEqual({ kind: "expired" })
      expect(atExpiry).toEqual({ kind: "expired" })
    } finally {
      harness.cleanup()
    }
  })

  it("allows only one upstream long poll for a session at a time", async () => {
    // Given: the first Tencent long poll is held open.
    const deferred = deferredQrStatus()
    const harness = createQrHarness("task-7-poll-mutex", [deferred.promise])

    try {
      const started = await startQrSession(harness)
      const firstPoll = harness.service.poll({
        ownerId: harness.ownerId,
        sessionId: started.session_id,
      })
      await Promise.resolve()

      // When: the same owner starts a concurrent poll.
      const concurrent = await harness.service.poll({
        ownerId: harness.ownerId,
        sessionId: started.session_id,
      })
      deferred.resolve({ status: "wait" })

      // Then: the second call is rejected while the first completes normally.
      expect(concurrent).toEqual({ kind: "poll_in_progress" })
      await expect(firstPoll).resolves.toMatchObject({ kind: "ok", value: { status: "wait" } })
      expect(harness.adapter.pollInputs).toHaveLength(1)
    } finally {
      harness.cleanup()
    }
  })

  it("refreshes expired QR codes at most three times", async () => {
    // Given: Tencent expires four consecutive QR codes.
    const harness = createQrHarness("task-7-refresh-cap", [
      { status: "expired" },
      { status: "expired" },
      { status: "expired" },
      { status: "expired" },
    ])

    try {
      const started = await startQrSession(harness)

      // When: all four expiration states are polled.
      const results = []
      for (let index = 0; index < 4; index += 1) {
        results.push(
          await harness.service.poll({
            ownerId: harness.ownerId,
            sessionId: started.session_id,
          }),
        )
      }

      // Then: only the first three fetch replacements and the fourth ends the session.
      expect(results.slice(0, 3)).toEqual([
        expect.objectContaining({ kind: "ok" }),
        expect.objectContaining({ kind: "ok" }),
        expect.objectContaining({ kind: "ok" }),
      ])
      expect(results.at(3)).toEqual({ kind: "expired" })
      expect(harness.adapter.fetchInputs).toHaveLength(4)
    } finally {
      harness.cleanup()
    }
  })

  it("uses a verification code for exactly one poll without retaining it", async () => {
    // Given: Tencent first requests a pairing code, then accepts it.
    const harness = createQrHarness("task-7-verify-ephemeral", [
      { status: "need_verifycode" },
      { status: "scaned" },
      { status: "wait" },
    ])

    try {
      const started = await startQrSession(harness)
      await harness.service.poll({ ownerId: harness.ownerId, sessionId: started.session_id })

      // When: the code is submitted and a later ordinary poll runs.
      await harness.service.verifyCode({
        ownerId: harness.ownerId,
        sessionId: started.session_id,
        verifyCode: "123456",
      })
      await harness.service.poll({ ownerId: harness.ownerId, sessionId: started.session_id })

      // Then: only the verification request carries the code.
      expect(harness.adapter.pollInputs.map(({ verifyCode }) => verifyCode ?? null)).toEqual([
        null,
        "123456",
        null,
      ])
    } finally {
      harness.cleanup()
    }
  })

  it("switches subsequent polls only to an adapter-approved redirect host", async () => {
    // Given: an approved Tencent shard redirect followed by a wait state.
    const harness = createQrHarness("task-7-redirect", [
      { status: "scaned_but_redirect", redirect_host: "shard.weixin.qq.com" },
      { status: "wait" },
    ])

    try {
      const started = await startQrSession(harness)

      // When: two status polls cross the redirect transition.
      await harness.service.poll({ ownerId: harness.ownerId, sessionId: started.session_id })
      await harness.service.poll({ ownerId: harness.ownerId, sessionId: started.session_id })

      // Then: the second request uses only the canonical HTTPS Tencent origin.
      expect(harness.adapter.pollInputs.map(({ baseUrl }) => baseUrl)).toEqual([
        "https://ilinkai.weixin.qq.com",
        "https://shard.weixin.qq.com",
      ])
    } finally {
      harness.cleanup()
    }
  })

  it.each(["bot_token", "ilink_bot_id", "ilink_user_id", "baseurl"] as const)(
    "rejects confirmed state missing %s without persistence",
    async (missingField) => {
      // Given: a confirmed response missing one required credential field.
      const harness = createQrHarness(`task-7-missing-${missingField}`, [
        withoutConfirmedField(missingField),
      ])

      try {
        const started = await startQrSession(harness)

        // When: confirmation crosses the state-machine boundary.
        const result = await harness.service.poll({
          ownerId: harness.ownerId,
          sessionId: started.session_id,
        })

        // Then: the upstream protocol fails and no bot row is committed.
        expect(result).toEqual({ kind: "upstream_failed" })
        const count = harness.database.client
          .prepare<[], { readonly count: number }>("SELECT count(*) AS count FROM bots")
          .get()
        expect(count?.count).toBe(0)
      } finally {
        harness.cleanup()
      }
    },
  )
})
