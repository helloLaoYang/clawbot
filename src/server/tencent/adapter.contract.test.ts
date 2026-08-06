// @vitest-environment node

import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"

import { type AxiosAdapter, AxiosHeaders, type InternalAxiosRequestConfig } from "axios"
import { describe, expect, it } from "vitest"

import type { BotCredentials } from "../db/contracts"
import { BotIdSchema, EpochMillisecondsSchema } from "../db/ids"
import { createTencentIlinkAdapter } from "./adapter"

const BOT_TOKEN = "bot-token-contract-secret"
const BASE_URL = "https://ilinkai.weixin.qq.com"

type TransportReply = {
  readonly body: string
  readonly status?: number
}

class ContractFixtureError extends Error {
  readonly name = "ContractFixtureError"
}

function createRecordingTransport(replies: readonly TransportReply[]): {
  readonly requests: InternalAxiosRequestConfig<unknown>[]
  readonly transport: AxiosAdapter
} {
  const requests: InternalAxiosRequestConfig<unknown>[] = []
  const remaining = [...replies]
  return {
    requests,
    transport: async (config) => {
      requests.push(config)
      const reply = remaining.shift()
      if (reply === undefined) {
        throw new ContractFixtureError("transport received an unexpected request")
      }
      return {
        config,
        data: reply.body,
        headers: new AxiosHeaders({ "content-type": "application/json" }),
        status: reply.status ?? 200,
        statusText: "stub",
      }
    },
  }
}

function credential(token: string, updatedAt: number): BotCredentials {
  return {
    baseUrl: BASE_URL,
    botId: BotIdSchema.parse(randomUUID()),
    botToken: token,
    createdAt: EpochMillisecondsSchema.parse(updatedAt - 1),
    updatedAt: EpochMillisecondsSchema.parse(updatedAt),
    webhookBearerHash: "a".repeat(64),
    webhookBearerLastFour: "a1b2",
  }
}

function parseRequestBody(config: InternalAxiosRequestConfig<unknown>): unknown {
  if (typeof config.data !== "string") {
    throw new ContractFixtureError("request body was not serialized JSON")
  }
  return JSON.parse(config.data)
}

function expectCommonHeaders(config: InternalAxiosRequestConfig<unknown>): void {
  expect(config.headers.get("iLink-App-Id")).toBe("bot")
  expect(config.headers.get("iLink-App-ClientVersion")).toBe("132102")
}

function expectAuthenticatedHeaders(config: InternalAxiosRequestConfig<unknown>): void {
  expectCommonHeaders(config)
  expect(config.headers.get("AuthorizationType")).toBe("ilink_bot_token")
  expect(config.headers.get("Authorization")).toBe(`Bearer ${BOT_TOKEN}`)
  const encodedUin = String(config.headers.get("X-WECHAT-UIN"))
  const decimalUin = Buffer.from(encodedUin, "base64").toString("ascii")
  expect(decimalUin).toMatch(/^(0|[1-9][0-9]{0,9})$/)
  expect(Number(decimalUin)).toBeLessThanOrEqual(0xffff_ffff)
}

describe("TencentIlinkAdapter wire contract", () => {
  it("sends the exact v2.4.6 QR request with the ten newest local tokens", async () => {
    // Given: twelve decrypted Task 4 credentials in oldest-first order.
    const localCredentials = Array.from({ length: 12 }, (_, index) =>
      credential(`token-${index}`, 1_800_000_000_000 + index),
    )
    const recording = createRecordingTransport([
      {
        body: JSON.stringify({
          qrcode: "qr-contract-secret",
          qrcode_img_content: "https://weixin.qq.com/x/approved-qr",
        }),
      },
    ])
    const adapter = createTencentIlinkAdapter({ transport: recording.transport })

    // When: a QR code is requested.
    const result = await adapter.fetchQrCode({ localCredentials })

    // Then: the pinned query, local-token order, limits, and unauthenticated headers are exact.
    expect(result).toEqual({
      qrcode: "qr-contract-secret",
      qrcode_img_content: "https://weixin.qq.com/x/approved-qr",
    })
    expect(recording.requests).toHaveLength(1)
    const request = recording.requests.at(0)
    expect(request).toBeDefined()
    if (request === undefined) {
      throw new ContractFixtureError("missing QR request")
    }
    expect(request.url).toBe(`${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`)
    expect(request.method).toBe("post")
    expect(request.timeout).toBe(15_000)
    expect(request.maxContentLength).toBe(1_048_576)
    expect(request.maxBodyLength).toBe(1_048_576)
    expect(request.maxRedirects).toBe(0)
    expectCommonHeaders(request)
    expect(request.headers.get("Authorization")).toBeUndefined()
    expect(request.headers.get("AuthorizationType")).toBe("ilink_bot_token")
    expect(parseRequestBody(request)).toEqual({
      local_token_list: [
        "token-11",
        "token-10",
        "token-9",
        "token-8",
        "token-7",
        "token-6",
        "token-5",
        "token-4",
        "token-3",
        "token-2",
      ],
    })
  })

  it("polls QR status for 35 seconds with only common GET headers", async () => {
    // Given: an approved QR status response and caller cancellation signal.
    const recording = createRecordingTransport([
      {
        body: JSON.stringify({
          status: "confirmed",
          bot_token: BOT_TOKEN,
          ilink_bot_id: "bot@im.bot",
          ilink_user_id: "user@im.wechat",
          baseurl: `${BASE_URL}/`,
        }),
      },
    ])
    const adapter = createTencentIlinkAdapter({ transport: recording.transport })
    const controller = new AbortController()

    // When: QR status is polled with a verification code.
    const result = await adapter.getQrStatus({
      baseUrl: BASE_URL,
      qrcode: "qr/value",
      signal: controller.signal,
      verifyCode: "123456",
    })

    // Then: timeout, query encoding, trusted base URL, and headers match v2.4.6.
    expect(result.baseurl).toBe(BASE_URL)
    const request = recording.requests.at(0)
    expect(request).toBeDefined()
    if (request === undefined) {
      throw new ContractFixtureError("missing QR status request")
    }
    expect(request.url).toBe(
      `${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=qr%2Fvalue&verify_code=123456`,
    )
    expect(request.method).toBe("get")
    expect(request.timeout).toBe(35_000)
    expect(request.signal).toBe(controller.signal)
    expectCommonHeaders(request)
    expect(request.headers.get("AuthorizationType")).toBeUndefined()
    expect(request.headers.get("X-WECHAT-UIN")).toBeUndefined()
  })

  it("sends getupdates with the exact cursor and base_info contract", async () => {
    // Given: an authenticated bot and one approved update response.
    const recording = createRecordingTransport([
      {
        body: JSON.stringify({
          ret: 0,
          msgs: [{ from_user_id: "user@im.wechat", context_token: "context-next" }],
          get_updates_buf: "cursor-next",
        }),
      },
    ])
    const adapter = createTencentIlinkAdapter({
      botAgent: "Clawbot/0.1.0",
      transport: recording.transport,
    })

    // When: updates resume from a persisted cursor.
    const result = await adapter.getUpdates({
      credentials: credential(BOT_TOKEN, 1_800_000_000_000),
      getUpdatesBuffer: "cursor-before",
    })

    // Then: the long poll is authenticated and includes only the pinned request fields.
    expect(result.get_updates_buf).toBe("cursor-next")
    const request = recording.requests.at(0)
    expect(request).toBeDefined()
    if (request === undefined) {
      throw new ContractFixtureError("missing getupdates request")
    }
    expect(request.url).toBe(`${BASE_URL}/ilink/bot/getupdates`)
    expect(request.timeout).toBe(35_000)
    expectAuthenticatedHeaders(request)
    expect(parseRequestBody(request)).toEqual({
      get_updates_buf: "cursor-before",
      base_info: { channel_version: "2.4.6", bot_agent: "Clawbot/0.1.0" },
    })
  })

  it("sends one finished text item and returns the stable client ID", async () => {
    // Given: a durable Task 4 job identity and a successful send response.
    const recording = createRecordingTransport([{ body: JSON.stringify({ ret: 0 }) }])
    const adapter = createTencentIlinkAdapter({ transport: recording.transport })

    // When: the adapter sends the queued text.
    const result = await adapter.sendMessage({
      clientId: "clawbot-stable-client-id",
      contextToken: "context-token",
      credentials: credential(BOT_TOKEN, 1_800_000_000_000),
      recipient: "recipient@im.wechat",
      text: "hello from the contract",
    })

    // Then: the exact single-item wire message is sent and message_id equals client_id.
    expect(result).toEqual({
      clientId: "clawbot-stable-client-id",
      messageId: "clawbot-stable-client-id",
    })
    const request = recording.requests.at(0)
    expect(request).toBeDefined()
    if (request === undefined) {
      throw new ContractFixtureError("missing send request")
    }
    expect(request.url).toBe(`${BASE_URL}/ilink/bot/sendmessage`)
    expect(request.timeout).toBe(15_000)
    expectAuthenticatedHeaders(request)
    expect(parseRequestBody(request)).toEqual({
      msg: {
        from_user_id: "",
        to_user_id: "recipient@im.wechat",
        client_id: "clawbot-stable-client-id",
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text: "hello from the contract" } }],
        context_token: "context-token",
      },
      base_info: { channel_version: "2.4.6", bot_agent: "OpenClaw" },
    })
  })

  it.each([
    ["notifyStart", "/ilink/bot/msg/notifystart"],
    ["notifyStop", "/ilink/bot/msg/notifystop"],
  ] as const)("sends %s with the pinned authenticated base_info", async (method, path) => {
    // Given: an authenticated bot and successful notification response.
    const recording = createRecordingTransport([{ body: JSON.stringify({ ret: 0 }) }])
    const adapter = createTencentIlinkAdapter({ transport: recording.transport })

    // When: lifecycle notification is emitted.
    await adapter[method]({ credentials: credential(BOT_TOKEN, 1_800_000_000_000) })

    // Then: it uses the regular timeout, exact endpoint, and no extra body fields.
    const request = recording.requests.at(0)
    expect(request).toBeDefined()
    if (request === undefined) {
      throw new ContractFixtureError("missing lifecycle request")
    }
    expect(request.url).toBe(`${BASE_URL}${path}`)
    expect(request.timeout).toBe(15_000)
    expectAuthenticatedHeaders(request)
    expect(parseRequestBody(request)).toEqual({
      base_info: { channel_version: "2.4.6", bot_agent: "OpenClaw" },
    })
  })
})
