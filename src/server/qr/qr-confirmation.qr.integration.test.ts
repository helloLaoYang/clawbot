// @vitest-environment node

import { randomUUID } from "node:crypto"

import { describe, expect, it } from "vitest"

import { BearerHashSchema } from "../config/config"
import { verifyBearer } from "../crypto/bearer"
import { deriveCryptoKeys } from "../crypto/keys"
import { createLookupHash } from "../crypto/lookup"
import { BotIdSchema, BotPublicIdSchema } from "../db/ids"
import { createBotInput } from "../db/test-support/fixtures"
import { confirmedStatus, createQrHarness, QR_TEST_APP_KEY, startQrSession } from "./test-support"

describe("QR confirmation persistence", () => {
  it("commits a new bot and reveals its webhook bearer only once", async () => {
    // Given: one new-bot session reaching a complete confirmed response.
    const harness = createQrHarness("task-7-one-time-bearer", [confirmedStatus])

    try {
      const started = await startQrSession(harness)

      // When: confirmation is polled twice.
      const first = await harness.service.poll({
        ownerId: harness.ownerId,
        sessionId: started.session_id,
      })
      const replay = await harness.service.poll({
        ownerId: harness.ownerId,
        sessionId: started.session_id,
      })

      // Then: the first response contains the generated bearer and replay cannot recover it.
      expect(first).toMatchObject({
        kind: "ok",
        value: {
          bot: {
            auth_status: "active",
            configured_max_sends_per_minute: 7,
            effective_max_sends_per_minute: 7,
            remark: "",
          },
          status: "confirmed",
        },
      })
      if (first.kind !== "ok" || first.value.bot === null || first.value.webhook_bearer === null) {
        return
      }
      expect(replay).toMatchObject({
        kind: "ok",
        value: { status: "confirmed", webhook_bearer: null },
      })
      const credentials = harness.database.bots.getCredentials(
        BotIdSchema.parse(
          harness.database.client.prepare<[], { readonly id: string }>("SELECT id FROM bots").get()
            ?.id,
        ),
      )
      expect(credentials).not.toBeNull()
      if (credentials !== null) {
        expect(
          verifyBearer(
            first.value.webhook_bearer,
            BearerHashSchema.parse(credentials.webhookBearerHash),
          ),
        ).toBe(true)
        expect(credentials.botToken).toBe(confirmedStatus.bot_token)
        expect(JSON.stringify(credentials)).not.toContain(first.value.webhook_bearer)
      }
    } finally {
      harness.cleanup()
    }
  })

  it("relogs the same upstream account while preserving local bot settings and bearer", async () => {
    // Given: an existing disabled bot with local settings and stale credentials.
    const harness = createQrHarness("task-7-relogin", [
      {
        ...confirmedStatus,
        bot_token: "replacement-bot-token",
        ilink_user_id: "replacement-user@im.wechat",
      },
    ])
    const existing = {
      ...createBotInput(),
      authStatus: "reauth_required" as const,
      enabled: false,
      ilinkBotId: confirmedStatus.ilink_bot_id,
      ilinkBotIdLookupHash: createLookupHash(
        confirmedStatus.ilink_bot_id,
        deriveCryptoKeys(QR_TEST_APP_KEY),
      ),
      maxSendsPerMinute: 23,
      publicId: BotPublicIdSchema.parse(randomUUID()),
      remark: "preserve me",
    }
    harness.database.bots.create(existing)
    const oldCredentials = harness.database.bots.getCredentials(existing.id)

    try {
      const started = await startQrSession(harness, existing.publicId)

      // When: the target account confirms with replacement Tencent credentials.
      const result = await harness.service.poll({
        ownerId: harness.ownerId,
        sessionId: started.session_id,
      })

      // Then: local identity/settings/bearer survive while auth and upstream secrets refresh atomically.
      expect(result).toMatchObject({
        kind: "ok",
        value: {
          bot: {
            auth_status: "active",
            configured_max_sends_per_minute: 23,
            effective_max_sends_per_minute: 23,
            enabled: false,
            public_id: existing.publicId,
            remark: "preserve me",
          },
          webhook_bearer: null,
        },
      })
      const stored = harness.database.bots.findByPublicId(existing.publicId)
      const credentials = harness.database.bots.getCredentials(existing.id)
      expect(stored).toMatchObject({
        id: existing.id,
        publicId: existing.publicId,
        remark: "preserve me",
        maxSendsPerMinute: 23,
        enabled: false,
        authStatus: "active",
      })
      expect(credentials).toMatchObject({
        botToken: "replacement-bot-token",
        webhookBearerHash: oldCredentials?.webhookBearerHash,
      })
    } finally {
      harness.cleanup()
    }
  })

  it("rejects relogin confirmation for a different upstream account", async () => {
    // Given: a relogin session targeting one persisted upstream account.
    const harness = createQrHarness("task-7-relogin-mismatch", [confirmedStatus])
    const existing = createBotInput()
    harness.database.bots.create(existing)
    const oldCredentials = harness.database.bots.getCredentials(existing.id)

    try {
      const started = await startQrSession(harness, existing.publicId)

      // When: Tencent confirms a different account identity.
      const result = await harness.service.poll({
        ownerId: harness.ownerId,
        sessionId: started.session_id,
      })

      // Then: the state is invalid and old credentials remain untouched.
      expect(result).toEqual({ kind: "invalid_state" })
      expect(harness.database.bots.getCredentials(existing.id)).toEqual(oldCredentials)
    } finally {
      harness.cleanup()
    }
  })
})
