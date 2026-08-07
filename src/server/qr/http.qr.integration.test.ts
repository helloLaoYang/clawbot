// @vitest-environment node

import { describe, expect, it } from "vitest"

import { createQrHttpHandlers, type QrHttpHandlers } from "./http"
import {
  createQrHarness,
  deferredQrStatus,
  QR_TEST_NOW,
  QR_TEST_ORIGIN,
  QR_TEST_SESSION_SECRET,
  type QrHarness,
  startQrSession,
} from "./test-support"

const JSON_HEADERS = { "content-type": "application/json" } as const

type HttpHarness = Readonly<{
  cookie: string
  handlers: QrHttpHandlers
  qr: QrHarness
}>

type PostRequestInput = Readonly<{
  body?: string
  cookie: string
  origin?: string
  path: string
}>

function createHttpHarness(
  label: string,
  statuses: Parameters<typeof createQrHarness>[1],
): HttpHarness {
  const qr = createQrHarness(label, statuses)
  return {
    cookie: `clawbot_admin_session=${qr.ownerToken}`,
    handlers: createQrHttpHandlers({
      allowedOrigin: QR_TEST_ORIGIN,
      clock: { now: () => QR_TEST_NOW },
      service: qr.service,
      sessionSecret: QR_TEST_SESSION_SECRET,
    }),
    qr,
  }
}

function postRequest(input: PostRequestInput): Request {
  return new Request(`http://localhost:3000${input.path}`, {
    ...(input.body === undefined ? {} : { body: input.body }),
    headers: {
      ...JSON_HEADERS,
      cookie: input.cookie,
      origin: input.origin ?? QR_TEST_ORIGIN,
    },
    method: "POST",
  })
}

describe("QR administrator HTTP contract", () => {
  it("returns exact no-store start and state response shapes for an authenticated cookie", async () => {
    // Given: a signed administrator cookie and a waiting Tencent QR adapter.
    const harness = createHttpHarness("task-7-http-shape", [{ status: "wait" }])

    try {
      // When: the browser starts and polls through the cookie-only handlers.
      const started = await harness.handlers.start(
        postRequest({ body: "{}", cookie: harness.cookie, path: "/api/admin/qr-sessions" }),
      )
      const startedBody = await started.json()
      const sessionId = Reflect.get(Object(startedBody), "session_id")
      const polled = await harness.handlers.poll(
        postRequest({
          cookie: harness.cookie,
          path: `/api/admin/qr-sessions/${String(sessionId)}/poll`,
        }),
        String(sessionId),
      )

      // Then: status, headers, and object keys match the fixed public contract exactly.
      expect(started.status).toBe(201)
      expect(started.headers.get("cache-control")).toBe("no-store")
      expect(started.headers.get("x-request-id")).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      )
      expect(Object.keys(Object(startedBody)).sort()).toEqual([
        "expires_at",
        "qrcode_url",
        "session_id",
        "status",
      ])
      expect(polled.status).toBe(200)
      await expect(polled.json()).resolves.toEqual({
        bot: null,
        qrcode_url: "https://weixin.qq.com/x/qr",
        requires_verify_code: false,
        status: "wait",
        webhook_bearer: null,
      })
    } finally {
      harness.qr.cleanup()
    }
  })

  it.each(["", " ", "1234567890123", "12a", "１２３"])(
    "rejects verify code %j before Tencent polling",
    async (verifyCode) => {
      // Given: an authenticated QR session and an out-of-contract pairing code.
      const harness = createHttpHarness(`task-7-http-code-${verifyCode.length}`, [
        { status: "wait" },
      ])

      try {
        const started = await startQrSession(harness.qr)

        // When: the browser submits the invalid code.
        const response = await harness.handlers.verifyCode(
          postRequest({
            body: JSON.stringify({ verify_code: verifyCode }),
            cookie: harness.cookie,
            path: `/api/admin/qr-sessions/${started.session_id}/verify-code`,
          }),
          started.session_id,
        )

        // Then: validation fails with the fixed envelope and no upstream request.
        expect(response.status).toBe(422)
        await expect(response.json()).resolves.toMatchObject({
          error: { code: "validation_failed", retryable: false },
        })
        expect(harness.qr.adapter.pollInputs).toHaveLength(0)
      } finally {
        harness.qr.cleanup()
      }
    },
  )

  it.each(["0", "123456789012"])(
    "accepts boundary verify code %j for exactly one Tencent poll",
    async (verifyCode) => {
      // Given: an authenticated QR session and a one- or twelve-digit pairing code.
      const harness = createHttpHarness(`task-7-http-valid-code-${verifyCode.length}`, [
        { status: "scaned" },
      ])

      try {
        const started = await startQrSession(harness.qr)

        // When: the browser submits the valid boundary value.
        const response = await harness.handlers.verifyCode(
          postRequest({
            body: JSON.stringify({ verify_code: verifyCode }),
            cookie: harness.cookie,
            path: `/api/admin/qr-sessions/${started.session_id}/verify-code`,
          }),
          started.session_id,
        )

        // Then: Tencent receives the exact digits and the state response succeeds.
        expect(response.status).toBe(200)
        expect(harness.qr.adapter.pollInputs.map(({ verifyCode: value }) => value)).toEqual([
          verifyCode,
        ])
      } finally {
        harness.qr.cleanup()
      }
    },
  )

  it("maps malformed input, missing auth, bad Origin, unknown IDs, and invalid relogin", async () => {
    // Given: one authenticated handler with no matching relogin target.
    const harness = createHttpHarness("task-7-http-errors", [])

    try {
      // When: each browser boundary is violated independently.
      const malformed = await harness.handlers.start(
        postRequest({ body: "{", cookie: harness.cookie, path: "/api/admin/qr-sessions" }),
      )
      const missingCookie = await harness.handlers.start(
        postRequest({ body: "{}", cookie: "", path: "/api/admin/qr-sessions" }),
      )
      const badOrigin = await harness.handlers.start(
        postRequest({
          body: "{}",
          cookie: harness.cookie,
          origin: "http://attacker.example",
          path: "/api/admin/qr-sessions",
        }),
      )
      const malformedId = await harness.handlers.poll(
        postRequest({ cookie: harness.cookie, path: "/api/admin/qr-sessions/not-an-id/poll" }),
        "not-an-id",
      )
      const restartedId = "A".repeat(43)
      const restarted = await harness.handlers.poll(
        postRequest({
          cookie: harness.cookie,
          path: `/api/admin/qr-sessions/${restartedId}/poll`,
        }),
        restartedId,
      )
      const relogin = await harness.handlers.start(
        postRequest({
          body: JSON.stringify({
            bot_public_id: "e4ed8b9a-6ce4-4d8f-9f53-878db9f45d70",
          }),
          cookie: harness.cookie,
          path: "/api/admin/qr-sessions",
        }),
      )

      // Then: each failure has the fixed HTTP status and machine code.
      const results = await Promise.all(
        [malformed, missingCookie, badOrigin, malformedId, restarted, relogin].map(
          async (response) => ({
            body: await response.json(),
            status: response.status,
          }),
        ),
      )
      expect(results.map(({ status }) => status)).toEqual([400, 401, 401, 404, 410, 409])
      expect(
        results.map(({ body }) => Reflect.get(Object(Reflect.get(Object(body), "error")), "code")),
      ).toEqual([
        "invalid_json",
        "unauthorized",
        "unauthorized",
        "not_found",
        "qr_expired",
        "invalid_state",
      ])
    } finally {
      harness.qr.cleanup()
    }
  })

  it("maps concurrent long polls to the fixed mutex error", async () => {
    // Given: one authenticated upstream poll held open.
    const deferred = deferredQrStatus()
    const harness = createHttpHarness("task-7-http-mutex", [deferred.promise])

    try {
      const started = await startQrSession(harness.qr)
      const first = harness.handlers.poll(
        postRequest({
          cookie: harness.cookie,
          path: `/api/admin/qr-sessions/${started.session_id}/poll`,
        }),
        started.session_id,
      )
      await Promise.resolve()

      // When: the browser sends a second poll before the first completes.
      const second = await harness.handlers.poll(
        postRequest({
          cookie: harness.cookie,
          path: `/api/admin/qr-sessions/${started.session_id}/poll`,
        }),
        started.session_id,
      )
      deferred.resolve({ status: "wait" })

      // Then: it receives 409 qr_poll_in_progress and the original succeeds.
      expect(second.status).toBe(409)
      await expect(second.json()).resolves.toMatchObject({
        error: { code: "qr_poll_in_progress" },
      })
      await expect(first).resolves.toMatchObject({ status: 200 })
    } finally {
      harness.qr.cleanup()
    }
  })
})
