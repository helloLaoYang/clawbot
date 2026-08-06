// @vitest-environment node

import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"

import {
  type AxiosAdapter,
  AxiosError,
  AxiosHeaders,
  CanceledError,
  type InternalAxiosRequestConfig,
} from "axios"
import { describe, expect, it } from "vitest"

import type { BotCredentials } from "../db/contracts"
import { BotIdSchema, EpochMillisecondsSchema } from "../db/ids"
import { createTencentIlinkAdapter } from "./adapter"
import { TencentIlinkError } from "./errors"
import { sanitizeBotAgent } from "./protocol"

const BASE_URL = "https://ilinkai.weixin.qq.com"
const BOT_TOKEN = "bot-token-must-never-leak"
const RAW_BODY_SECRET = "raw-upstream-body-must-never-leak"

class ErrorFixtureError extends Error {
  readonly name = "ErrorFixtureError"
}

function credentials(): BotCredentials {
  return {
    baseUrl: BASE_URL,
    botId: BotIdSchema.parse(randomUUID()),
    botToken: BOT_TOKEN,
    createdAt: EpochMillisecondsSchema.parse(1_800_000_000_000),
    updatedAt: EpochMillisecondsSchema.parse(1_800_000_000_000),
    webhookBearerHash: "b".repeat(64),
    webhookBearerLastFour: "b1c2",
  }
}

function replyTransport(
  body: string,
  status = 200,
): {
  readonly calls: InternalAxiosRequestConfig<unknown>[]
  readonly transport: AxiosAdapter
} {
  const calls: InternalAxiosRequestConfig<unknown>[] = []
  return {
    calls,
    transport: async (config) => {
      calls.push(config)
      return {
        config,
        data: body,
        headers: new AxiosHeaders(),
        status,
        statusText: "stub",
      }
    },
  }
}

async function captureError(action: () => Promise<unknown>): Promise<TencentIlinkError> {
  try {
    await action()
  } catch (error) {
    if (error instanceof TencentIlinkError) {
      return error
    }
    throw error
  }
  throw new ErrorFixtureError("expected a TencentIlinkError")
}

function send(
  adapter: ReturnType<typeof createTencentIlinkAdapter>,
  text = "hello",
): Promise<unknown> {
  return adapter.sendMessage({
    clientId: "stable-client-id",
    contextToken: "context-token",
    credentials: credentials(),
    recipient: "recipient@im.wechat",
    text,
  })
}

describe("TencentIlinkAdapter failure contract", () => {
  it("truncates a long valid bot agent by complete products and defaults invalid input", () => {
    // Given: valid products beyond the wire cap and a header-injection-shaped value.
    const longAgent = Array.from({ length: 50 }, (_, index) => `App${index}/1.0`).join(" ")

    // When: both values are sanitized for base_info.
    const truncated = sanitizeBotAgent(longAgent)
    const fallback = sanitizeBotAgent("Injected:\r\nvalue")

    // Then: valid products are retained whole under 256 bytes and invalid input uses the default.
    expect(truncated).toMatch(/^App0\/1\.0(?: App[0-9]+\/1\.0)*$/)
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(256)
    expect(fallback).toBe("OpenClaw")
  })

  it.each([
    [429, JSON.stringify({ error: RAW_BODY_SECRET }), "rate_limited"],
    [500, RAW_BODY_SECRET, "upstream_http"],
    [200, JSON.stringify({ ret: -14, errmsg: RAW_BODY_SECRET }), "reauth_required"],
    [200, JSON.stringify({ ret: -2, errmsg: RAW_BODY_SECRET }), "rate_limited"],
    [200, JSON.stringify({ ret: 7, errmsg: RAW_BODY_SECRET }), "upstream_protocol"],
    [200, `{${RAW_BODY_SECRET}`, "upstream_protocol"],
  ] as const)(
    "maps status %s to %s without response or credential disclosure",
    async (status, body, expectedKind) => {
      // Given: one deterministic upstream failure.
      const reply = replyTransport(body, status)
      const adapter = createTencentIlinkAdapter({ transport: reply.transport })

      // When: one send attempt fails.
      const error = await captureError(() => send(adapter))

      // Then: the error is typed, redacted, and the adapter does not retry internally.
      expect(error.details.kind).toBe(expectedKind)
      expect(reply.calls).toHaveLength(1)
      const serialized = JSON.stringify(error)
      expect(serialized).not.toContain(BOT_TOKEN)
      expect(serialized).not.toContain(RAW_BODY_SECRET)
    },
  )

  it.each([
    [AxiosError.ETIMEDOUT, "timeout"],
    [AxiosError.ECONNABORTED, "timeout"],
    [AxiosError.ERR_NETWORK, "network"],
  ] as const)("maps Axios %s to %s without retaining its secret config", async (code, kind) => {
    // Given: an Axios transport error carrying the token-bearing request config.
    const transport: AxiosAdapter = (config) =>
      Promise.reject(new AxiosError(RAW_BODY_SECRET, code, config))
    const adapter = createTencentIlinkAdapter({ transport })

    // When: the transport fails before a response.
    const error = await captureError(() => send(adapter))

    // Then: only the stable typed variant survives.
    expect(error.details.kind).toBe(kind)
    expect(JSON.stringify(error)).not.toContain(BOT_TOKEN)
    expect(JSON.stringify(error)).not.toContain(RAW_BODY_SECRET)
  })

  it("maps the Axios content-length rejection to the redacted response limit variant", async () => {
    // Given: the real Axios adapter's error code for exceeding maxContentLength.
    const transport: AxiosAdapter = (config) =>
      Promise.reject(
        new AxiosError(
          "maxContentLength size of 1048576 exceeded",
          AxiosError.ERR_BAD_RESPONSE,
          config,
        ),
      )
    const adapter = createTencentIlinkAdapter({ transport })

    // When: the response cap rejects a send.
    const error = await captureError(() => send(adapter))

    // Then: callers receive the same typed limit result as injected oversized content.
    expect(error.details).toEqual({ kind: "upstream_protocol", reason: "response_too_large" })
    expect(JSON.stringify(error)).not.toContain(RAW_BODY_SECRET)
  })

  it("forwards AbortSignal and maps cancellation separately from timeout", async () => {
    // Given: an already-cancelled caller signal and Axios cancellation.
    const controller = new AbortController()
    controller.abort()
    const transport: AxiosAdapter = (config) =>
      Promise.reject(new CanceledError(RAW_BODY_SECRET, AxiosError.ERR_CANCELED, config))
    const adapter = createTencentIlinkAdapter({ transport })

    // When: getupdates starts under the cancelled signal.
    const error = await captureError(() =>
      adapter.getUpdates({
        credentials: credentials(),
        getUpdatesBuffer: "",
        signal: controller.signal,
      }),
    )

    // Then: cancellation has its own typed variant and remains redacted.
    expect(error.details.kind).toBe("aborted")
    expect(JSON.stringify(error)).not.toContain(BOT_TOKEN)
    expect(JSON.stringify(error)).not.toContain(RAW_BODY_SECRET)
  })

  it.each([
    "http://ilinkai.weixin.qq.com",
    "https://user:pass@ilinkai.weixin.qq.com",
    "https://ilinkai.weixin.qq.com:8443",
    "https://weixin.qq.com.evil.example",
    "https://evilweixin.qq.com",
    "https://example.com",
  ])("rejects malicious token-bearing origin %s before transport", async (baseUrl) => {
    // Given: credentials with an untrusted base URL.
    const reply = replyTransport(JSON.stringify({ ret: 0 }))
    const adapter = createTencentIlinkAdapter({ transport: reply.transport })
    const maliciousCredentials = { ...credentials(), baseUrl }

    // When: a token-bearing request is attempted.
    const error = await captureError(() =>
      adapter.getUpdates({ credentials: maliciousCredentials, getUpdatesBuffer: "" }),
    )

    // Then: origin validation fails before the token reaches transport.
    expect(error.details.kind).toBe("invalid_origin")
    expect(reply.calls).toHaveLength(0)
  })

  it("rejects an untrusted QR display URL without exposing QR response content", async () => {
    // Given: a QR response pointing outside the approved Tencent origin.
    const reply = replyTransport(
      JSON.stringify({ qrcode: RAW_BODY_SECRET, qrcode_img_content: "https://evil.example/qr" }),
    )
    const adapter = createTencentIlinkAdapter({ transport: reply.transport })

    // When: the QR response crosses the protocol boundary.
    const error = await captureError(() => adapter.fetchQrCode({ localCredentials: [] }))

    // Then: display content is rejected and absent from diagnostics.
    expect(error.details.kind).toBe("invalid_origin")
    expect(JSON.stringify(error)).not.toContain(RAW_BODY_SECRET)
  })

  it.each([
    ["baseurl", "https://evil.example"],
    ["redirect_host", "evil.example"],
  ] as const)(
    "rejects an untrusted QR status %s before it can be persisted",
    async (field, value) => {
      // Given: a QR status response carrying an attacker-controlled next origin.
      const reply = replyTransport(JSON.stringify({ status: "confirmed", [field]: value }))
      const adapter = createTencentIlinkAdapter({ transport: reply.transport })

      // When: QR status crosses the trusted-origin boundary.
      const error = await captureError(() =>
        adapter.getQrStatus({ baseUrl: BASE_URL, qrcode: "approved-qr" }),
      )

      // Then: neither a persisted base URL nor a redirect host can leave weixin.qq.com.
      expect(error.details.kind).toBe("invalid_origin")
    },
  )

  it("enforces the one MiB response limit with an injected transport", async () => {
    // Given: a custom transport returning more than the configured Axios cap.
    const reply = replyTransport("x".repeat(1_048_577))
    const adapter = createTencentIlinkAdapter({ transport: reply.transport })

    // When: the oversized response is received.
    const error = await captureError(() => send(adapter))

    // Then: transport-independent boundary enforcement rejects it without retaining the body.
    expect(error.details).toEqual({ kind: "upstream_protocol", reason: "response_too_large" })
    expect(JSON.stringify(error)).not.toContain("x".repeat(128))
  })

  it("enforces the one MiB request limit before invoking transport", async () => {
    // Given: a send payload larger than the Axios body cap.
    const reply = replyTransport(JSON.stringify({ ret: 0 }))
    const adapter = createTencentIlinkAdapter({ transport: reply.transport })

    // When: serialization exceeds one MiB.
    const error = await captureError(() => send(adapter, "x".repeat(1_048_577)))

    // Then: no request is attempted and no payload is retained.
    expect(error.details).toEqual({ kind: "upstream_protocol", reason: "request_too_large" })
    expect(reply.calls).toHaveLength(0)
    expect(JSON.stringify(error)).not.toContain("x".repeat(128))
  })
})
