// @vitest-environment node

import { randomUUID } from "node:crypto"

import { describe, expect, it } from "vitest"

import {
  createTencentStubTransport,
  startTencentStub,
  type TencentStubMode,
} from "../../../tests/support/tencent-stub"
import type { BotCredentials } from "../db/contracts"
import { BotIdSchema, EpochMillisecondsSchema } from "../db/ids"
import { createTencentIlinkAdapter } from "./adapter"
import type { TencentIlinkError } from "./errors"

function credentials(botToken: string): BotCredentials {
  return {
    baseUrl: "https://ilinkai.weixin.qq.com",
    botId: BotIdSchema.parse(randomUUID()),
    botToken,
    createdAt: EpochMillisecondsSchema.parse(1_800_000_000_000),
    updatedAt: EpochMillisecondsSchema.parse(1_800_000_000_000),
    webhookBearerHash: "c".repeat(64),
    webhookBearerLastFour: "c1d2",
  }
}

describe("Tencent local protocol stub", () => {
  it("drives QR status, updates, and send through a real local HTTP server", async () => {
    // Given: a real ephemeral HTTP stub reached only by the injected Axios transport.
    const stub = await startTencentStub()
    const adapter = createTencentIlinkAdapter({
      transport: createTencentStubTransport(stub.origin),
    })

    try {
      // When: the complete protocol surface is driven without contacting Tencent.
      const qr = await adapter.fetchQrCode({ localCredentials: [credentials("local-token")] })
      const status = await adapter.getQrStatus({
        baseUrl: "https://ilinkai.weixin.qq.com",
        qrcode: qr.qrcode,
      })
      const updates = await adapter.getUpdates({
        credentials: credentials(status.bot_token ?? ""),
        getUpdatesBuffer: "stub-cursor-before",
      })
      const send = await adapter.sendMessage({
        clientId: "stub-stable-client-id",
        contextToken: updates.msgs.at(0)?.context_token ?? "",
        credentials: credentials(status.bot_token ?? ""),
        recipient: updates.msgs.at(0)?.from_user_id ?? "",
        text: "stub hello",
      })

      // Then: every request reached the stub in order with the observable send identity intact.
      expect(send.messageId).toBe("stub-stable-client-id")
      expect(stub.requests.map(({ path }) => path)).toEqual([
        "/ilink/bot/get_bot_qrcode?bot_type=3",
        "/ilink/bot/get_qrcode_status?qrcode=stub-qr",
        "/ilink/bot/getupdates",
        "/ilink/bot/sendmessage",
      ])
      expect(stub.requests.at(2)?.authorization).toBe("Bearer stub-bot-token")
      expect(stub.requests.at(3)?.body).toMatchObject({
        msg: { client_id: "stub-stable-client-id", to_user_id: "stub-user@im.wechat" },
      })
    } finally {
      await stub.close()
    }
  })

  it("does not follow a redirect returned by the real HTTP stub", async () => {
    // Given: a local server that redirects the first send.
    const stub = await startTencentStub()
    stub.setMode("redirect")
    const adapter = createTencentIlinkAdapter({
      transport: createTencentStubTransport(stub.origin),
    })

    try {
      // When: the token-bearing send receives HTTP 302.
      const pending = adapter.sendMessage({
        clientId: "stub-redirect-client-id",
        contextToken: "stub-context",
        credentials: credentials("stub-bot-token"),
        recipient: "stub-user@im.wechat",
        text: "must not redirect",
      })

      // Then: Axios surfaces 302 and no second request reaches the redirect target.
      await expect(pending).rejects.toMatchObject({
        details: { kind: "upstream_http", status: 302 },
      } satisfies Partial<TencentIlinkError>)
      expect(stub.requests).toHaveLength(1)
      expect(stub.requests.at(0)?.path).toBe("/ilink/bot/sendmessage")
    } finally {
      await stub.close()
    }
  })

  it.each([
    ["http_429", "rate_limited"],
    ["http_500", "upstream_http"],
    ["ret_-14", "reauth_required"],
    ["ret_-2", "rate_limited"],
    ["malformed", "upstream_protocol"],
  ] satisfies readonly (readonly [TencentStubMode, string])[])(
    "maps local stub mode %s to %s with one HTTP attempt",
    async (mode, expectedKind) => {
      // Given: one real local HTTP stub failure mode.
      const stub = await startTencentStub()
      stub.setMode(mode)
      const adapter = createTencentIlinkAdapter({
        transport: createTencentStubTransport(stub.origin),
      })

      try {
        // When: an authenticated send reaches the failing stub.
        const pending = adapter.sendMessage({
          clientId: "stub-failure-client-id",
          contextToken: "stub-context",
          credentials: credentials("stub-bot-token"),
          recipient: "stub-user@im.wechat",
          text: "classify local failure",
        })

        // Then: the typed variant is exact and no internal retry occurs.
        await expect(pending).rejects.toMatchObject({ details: { kind: expectedKind } })
        expect(stub.requests).toHaveLength(1)
      } finally {
        await stub.close()
      }
    },
  )

  it("maps a real local stalled response to the exact 15 second timeout variant", async () => {
    // Given: a local server that accepts the request but never responds.
    const stub = await startTencentStub()
    stub.setMode("timeout")
    const adapter = createTencentIlinkAdapter({
      transport: createTencentStubTransport(stub.origin),
    })

    try {
      // When: a regular send reaches the fixed Axios timeout.
      const pending = adapter.sendMessage({
        clientId: "stub-timeout-client-id",
        contextToken: "stub-context",
        credentials: credentials("stub-bot-token"),
        recipient: "stub-user@im.wechat",
        text: "timeout locally",
      })

      // Then: the transport reports timeout once without retrying.
      await expect(pending).rejects.toMatchObject({ details: { kind: "timeout" } })
      expect(stub.requests).toHaveLength(1)
    } finally {
      await stub.close()
    }
  }, 20_000)
})
