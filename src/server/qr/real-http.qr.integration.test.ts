// @vitest-environment node

import { Buffer } from "node:buffer"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"

import { afterEach, describe, expect, it } from "vitest"

import { createTencentStubTransport, startTencentStub } from "../../../tests/support/tencent-stub"
import { createAdminSession } from "../crypto/admin-auth"
import { deriveCryptoKeys } from "../crypto/keys"
import { createTestDatabase, openTestDatabase } from "../db/test-support/fixtures"
import { createTencentIlinkAdapter } from "../tencent/adapter"
import { createQrHttpHandlers, type QrHttpHandlers } from "./http"
import { createQrOnboardingService } from "./service"
import {
  QR_TEST_APP_KEY,
  QR_TEST_NOW,
  QR_TEST_ORIGIN,
  QR_TEST_SESSION_SECRET,
} from "./test-support"

type HttpResult = Readonly<{
  body: unknown
  status: number
}>

type PostJsonInput = Readonly<{
  body?: string
  cookie: string
  origin: string
  path: string
}>

class QrRealHttpError extends Error {
  readonly name = "QrRealHttpError"
}

const runningServers: Server[] = []

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString("utf8")
}

async function writeResponse(response: ServerResponse, result: Response): Promise<void> {
  const headers: Record<string, string> = {}
  result.headers.forEach((value, name) => {
    headers[name] = value
  })
  response.writeHead(result.status, headers)
  response.end(Buffer.from(await result.arrayBuffer()))
}

async function dispatch(
  request: IncomingMessage,
  response: ServerResponse,
  handlers: QrHttpHandlers,
): Promise<void> {
  const path = request.url ?? "/"
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      headers.set(name, value)
    }
  }
  const webRequest = new Request(`http://localhost${path}`, {
    body: await readBody(request),
    headers,
    method: request.method ?? "POST",
  })
  if (path === "/api/admin/qr-sessions") {
    await writeResponse(response, await handlers.start(webRequest))
    return
  }
  const match = /^\/api\/admin\/qr-sessions\/([^/]+)\/(poll|verify-code)$/.exec(path)
  const sessionId = match?.at(1)
  const action = match?.at(2)
  if (sessionId === undefined || action === undefined) {
    response.writeHead(404)
    response.end()
    return
  }
  await writeResponse(
    response,
    action === "poll"
      ? await handlers.poll(webRequest, sessionId)
      : await handlers.verifyCode(webRequest, sessionId),
  )
}

async function stopQrServer(server: Server): Promise<void> {
  if (!server.listening) {
    return
  }
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)))
  })
}

async function startQrServer(
  handlers: QrHttpHandlers,
): Promise<Readonly<{ origin: string; server: Server }>> {
  const server = createServer((request, response) => {
    void dispatch(request, response, handlers).catch((error: unknown) => {
      response.writeHead(500)
      response.end(error instanceof Error ? error.name : "unknown")
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  runningServers.push(server)
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new QrRealHttpError("QR HTTP server did not bind an IP socket")
  }
  return { origin: `http://127.0.0.1:${address.port}`, server }
}

async function postJson(input: PostJsonInput): Promise<HttpResult> {
  const response = await fetch(`${input.origin}${input.path}`, {
    body: input.body ?? "",
    headers: { "content-type": "application/json", cookie: input.cookie, origin: QR_TEST_ORIGIN },
    method: "POST",
  })
  return { body: await response.json(), status: response.status }
}

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map(stopQrServer))
})

describe("QR real HTTP flow", () => {
  it("confirms through a local Tencent stub, expires on restart, and rejects malicious redirect", async () => {
    // Given: real HTTP handlers, SQLite, and an HTTP-level Tencent transport stub.
    const testDatabase = createTestDatabase("task-7-real-http")
    const database = openTestDatabase(testDatabase.path)
    const tencent = await startTencentStub()
    const owner = createAdminSession(QR_TEST_SESSION_SECRET, QR_TEST_NOW)
    const cookie = `clawbot_admin_session=${owner.token}`
    const createHandlers = () =>
      createQrHttpHandlers({
        allowedOrigin: QR_TEST_ORIGIN,
        clock: { now: () => QR_TEST_NOW },
        service: createQrOnboardingService({
          adapter: createTencentIlinkAdapter({
            transport: createTencentStubTransport(tencent.origin),
          }),
          bots: database.bots,
          clock: { now: () => QR_TEST_NOW },
          keys: deriveCryptoKeys(QR_TEST_APP_KEY),
          limits: { defaultBotMaxSendsPerMinute: 7, tencentMaxSendsPerMinute: 60 },
          qrBots: database.qrBots,
        }),
        sessionSecret: QR_TEST_SESSION_SECRET,
      })

    try {
      const firstServer = await startQrServer(createHandlers())

      // When: onboarding confirms, the HTTP runtime restarts, and a new QR gets an evil redirect.
      const started = await postJson({
        body: "{}",
        cookie,
        origin: firstServer.origin,
        path: "/api/admin/qr-sessions",
      })
      const sessionId = String(Reflect.get(Object(started.body), "session_id"))
      const confirmed = await postJson({
        cookie,
        origin: firstServer.origin,
        path: `/api/admin/qr-sessions/${sessionId}/poll`,
      })
      await stopQrServer(firstServer.server)
      const restartedServer = await startQrServer(createHandlers())
      const afterRestart = await postJson({
        cookie,
        origin: restartedServer.origin,
        path: `/api/admin/qr-sessions/${sessionId}/poll`,
      })
      tencent.setQrStatuses([
        { status: "scaned_but_redirect", redirect_host: "weixin.qq.com.evil.example" },
      ])
      const maliciousStart = await postJson({
        body: "{}",
        cookie,
        origin: restartedServer.origin,
        path: "/api/admin/qr-sessions",
      })
      const maliciousSessionId = String(Reflect.get(Object(maliciousStart.body), "session_id"))
      const malicious = await postJson({
        cookie,
        origin: restartedServer.origin,
        path: `/api/admin/qr-sessions/${maliciousSessionId}/poll`,
      })

      // Then: one bot is durable, sessions are process-local, and attacker origins never persist.
      expect(started.status).toBe(201)
      expect(confirmed).toMatchObject({
        body: { status: "confirmed", webhook_bearer: expect.stringMatching(/^[\w-]{43}$/) },
        status: 200,
      })
      expect(afterRestart).toMatchObject({ body: { error: { code: "qr_expired" } }, status: 410 })
      expect(malicious).toMatchObject({
        body: { error: { code: "upstream_failed" } },
        status: 502,
      })
      const count = database.client
        .prepare<[], { readonly count: number }>("SELECT count(*) AS count FROM bots")
        .get()
      expect(count?.count).toBe(1)
    } finally {
      await tencent.close()
      database.close()
      testDatabase.cleanup()
    }
  })
})
