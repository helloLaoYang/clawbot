import { Buffer } from "node:buffer"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

import axios, { type AxiosAdapter } from "axios"

import type { QrStatusResponse } from "../../src/server/tencent/protocol"

export const TENCENT_STUB_MODES = [
  "ok",
  "http_429",
  "http_500",
  "timeout",
  "ret_-14",
  "ret_-2",
  "errcode_-14",
  "errcode_73",
  "malformed",
  "redirect",
] as const
export type TencentStubMode = (typeof TENCENT_STUB_MODES)[number]

export type TencentStubRequest = {
  readonly authorization: string | null
  readonly body: unknown
  readonly method: string
  readonly path: string
}

export type TencentStub = {
  readonly origin: string
  readonly requests: readonly TencentStubRequest[]
  readonly close: () => Promise<void>
  readonly setMode: (mode: TencentStubMode) => void
  readonly setQrStatuses: (statuses: readonly QrStatusResponse[]) => void
}

type TencentStubState = {
  mode: TencentStubMode
  qrSequence: number
  qrStatuses: QrStatusResponse[]
  requests: TencentStubRequest[]
}

class TencentStubError extends Error {
  readonly name = "TencentStubError"
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    request.once("error", reject)
  })
}

function decodeJson(body: string): unknown {
  return body === "" ? null : JSON.parse(body)
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

function sendMode(response: ServerResponse, mode: TencentStubMode): boolean {
  switch (mode) {
    case "ok":
      return false
    case "http_429":
      sendJson(response, 429, { error: "stub rate limit" })
      return true
    case "http_500":
      sendJson(response, 500, { error: "stub failure" })
      return true
    case "timeout":
      return true
    case "ret_-14":
      sendJson(response, 200, { ret: -14 })
      return true
    case "ret_-2":
      sendJson(response, 200, { ret: -2 })
      return true
    case "errcode_-14":
      sendJson(response, 200, { ret: 0, errcode: -14 })
      return true
    case "errcode_73":
      sendJson(response, 200, { ret: 0, errcode: 73 })
      return true
    case "malformed":
      response.writeHead(200, { "content-type": "application/json" })
      response.end("{malformed")
      return true
    case "redirect":
      response.writeHead(302, { location: "/redirect-target" })
      response.end()
      return true
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: TencentStubState,
): Promise<void> {
  const method = request.method ?? ""
  const path = request.url ?? ""
  const rawBody = await readRequestBody(request)
  state.requests.push({
    authorization: request.headers.authorization ?? null,
    body: decodeJson(rawBody),
    method,
    path,
  })

  if (sendMode(response, state.mode)) {
    return
  }
  if (method === "POST" && path === "/ilink/bot/get_bot_qrcode?bot_type=3") {
    state.qrSequence += 1
    const suffix = state.qrSequence === 1 ? "" : `-${state.qrSequence}`
    sendJson(response, 200, {
      qrcode: `stub-qr${suffix}`,
      qrcode_img_content: `https://weixin.qq.com/x/stub-qr${suffix}`,
    })
    return
  }
  if (method === "GET" && path.startsWith("/ilink/bot/get_qrcode_status?")) {
    sendJson(
      response,
      200,
      state.qrStatuses.shift() ?? {
        status: "confirmed",
        bot_token: "stub-bot-token",
        ilink_bot_id: "stub-bot@im.bot",
        ilink_user_id: "stub-user@im.wechat",
        baseurl: "https://ilinkai.weixin.qq.com",
      },
    )
    return
  }
  if (method === "POST" && path === "/ilink/bot/getupdates") {
    sendJson(response, 200, {
      ret: 0,
      msgs: [{ from_user_id: "stub-user@im.wechat", context_token: "stub-context" }],
      get_updates_buf: "stub-cursor-next",
    })
    return
  }
  if (
    method === "POST" &&
    ["/ilink/bot/sendmessage", "/ilink/bot/msg/notifystart", "/ilink/bot/msg/notifystop"].includes(
      path,
    )
  ) {
    sendJson(response, 200, { ret: 0 })
    return
  }
  sendJson(response, 404, { error: "stub route not found" })
}

export async function startTencentStub(): Promise<TencentStub> {
  const state: TencentStubState = { mode: "ok", qrSequence: 0, qrStatuses: [], requests: [] }
  const server = createServer((request, response) => {
    void handleRequest(request, response, state).catch((error: unknown) => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: "stub handler failure" })
      } else {
        response.destroy()
      }
      if (!(error instanceof Error)) {
        throw error
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    server.close()
    throw new TencentStubError("stub did not bind an IP socket")
  }

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => {
          if (error === undefined) {
            resolve()
          } else {
            reject(error)
          }
        })
      }),
    origin: `http://127.0.0.1:${address.port}`,
    requests: state.requests,
    setMode: (nextMode) => {
      state.mode = nextMode
    },
    setQrStatuses: (statuses) => {
      state.qrStatuses = [...statuses]
    },
  }
}

export function createTencentStubTransport(origin: string): AxiosAdapter {
  const httpAdapter = axios.getAdapter("http")
  return (config) => {
    if (config.url === undefined) {
      throw new TencentStubError("transport request URL is missing")
    }
    const trustedUrl = new URL(config.url)
    const localUrl = new URL(`${trustedUrl.pathname}${trustedUrl.search}`, origin)
    return httpAdapter({ ...config, proxy: false, url: localUrl.toString() })
  }
}
