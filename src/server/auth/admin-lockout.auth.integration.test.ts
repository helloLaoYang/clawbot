// @vitest-environment node

import { Buffer } from "node:buffer"

import { describe, expect, it } from "vitest"

import { AdminPasswordHashSchema, SessionSecretSchema } from "../config/config"
import { createTestDatabase, openTestDatabase } from "../db/test-support/fixtures"
import { ADMIN_LOGIN_WINDOW_MS, createAdminAuthHandlers } from "./admin"

const ADMIN_ORIGIN = "http://localhost:3000"
const PASSWORD_HASH = AdminPasswordHashSchema.parse(
  "scrypt$v1$32768$8$1$AAECAwQFBgcICQoLDA0ODw$eo40JB24mNWRdcaWU4xBdGepdf_laQaEJfFhiNMVnFg",
)
const SESSION_SECRET = SessionSecretSchema.parse(Buffer.alloc(32, 71).toString("base64"))
const STARTED_AT = 1_710_000_000_000

function loginRequest(password: string, forwardedFor?: string): Request {
  const headers = new Headers({
    "content-type": "application/json",
    origin: ADMIN_ORIGIN,
  })
  if (forwardedFor !== undefined) {
    headers.set("x-forwarded-for", forwardedFor)
  }
  return new Request("http://localhost:3000/api/admin/auth/login", {
    body: JSON.stringify({ password }),
    headers,
    method: "POST",
  })
}

describe("persisted administrator login throttle", () => {
  it("locks globally on the exact fifth failure and survives a database restart", async () => {
    // Given: one persisted global login identity and changing proxy IP headers.
    const testDatabase = createTestDatabase("task-6-lock-restart")
    const first = openTestDatabase(testDatabase.path)
    const firstHandlers = createAdminAuthHandlers({
      allowedOrigin: ADMIN_ORIGIN,
      clock: { now: () => STARTED_AT },
      passwordHash: PASSWORD_HASH,
      runtime: first.runtime,
      secureCookies: false,
      sessionSecret: SESSION_SECRET,
    })

    try {
      // When: five bad passwords arrive under five claimed proxy identities.
      for (let attempt = 1; attempt < 5; attempt += 1) {
        const response = await firstHandlers.login(loginRequest("wrong", `192.0.2.${attempt}`))
        expect(response.status).toBe(401)
      }
      const fifth = await firstHandlers.login(loginRequest("wrong", "198.51.100.5"))

      // Then: the fifth response starts one exact 15-minute lock persisted across restart.
      expect(fifth.status).toBe(429)
      expect(fifth.headers.get("retry-after")).toBe("900")
      await expect(fifth.json()).resolves.toMatchObject({
        error: { code: "rate_limited", retryable: true },
      })
      expect(first.runtime.getAdminLoginState()).toEqual({
        failedAttempts: 5,
        lockedUntil: STARTED_AT + ADMIN_LOGIN_WINDOW_MS,
        updatedAt: STARTED_AT,
        windowStartedAt: STARTED_AT,
      })

      first.close()
      const restarted = openTestDatabase(testDatabase.path)
      try {
        const restartedHandlers = createAdminAuthHandlers({
          allowedOrigin: ADMIN_ORIGIN,
          clock: { now: () => STARTED_AT + 1 },
          passwordHash: PASSWORD_HASH,
          runtime: restarted.runtime,
          secureCookies: false,
          sessionSecret: SESSION_SECRET,
        })
        const blocked = await restartedHandlers.login(loginRequest("correct horse battery staple"))
        expect(blocked.status).toBe(429)
        expect(blocked.headers.get("retry-after")).toBe("900")
      } finally {
        restarted.close()
      }
    } finally {
      if (first.client.open) {
        first.close()
      }
      testDatabase.cleanup()
    }
  })

  it("unlocks at the exact boundary and resets state after a successful login", async () => {
    // Given: a persisted lock created by five failed passwords.
    const testDatabase = createTestDatabase("task-6-lock-boundary")
    const database = openTestDatabase(testDatabase.path)
    let now = STARTED_AT
    const handlers = createAdminAuthHandlers({
      allowedOrigin: ADMIN_ORIGIN,
      clock: { now: () => now },
      passwordHash: PASSWORD_HASH,
      runtime: database.runtime,
      secureCookies: false,
      sessionSecret: SESSION_SECRET,
    })

    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await handlers.login(loginRequest("wrong"))
      }

      // When: the correct password is submitted at locked_until exactly.
      now = STARTED_AT + ADMIN_LOGIN_WINDOW_MS
      const response = await handlers.login(loginRequest("correct horse battery staple"))

      // Then: login succeeds and clears every persisted throttle field.
      expect(response.status).toBe(204)
      expect(database.runtime.getAdminLoginState()).toEqual({
        failedAttempts: 0,
        lockedUntil: null,
        updatedAt: now,
        windowStartedAt: null,
      })
    } finally {
      database.close()
      testDatabase.cleanup()
    }
  })

  it("starts a new failure window at the exact 15-minute boundary", async () => {
    // Given: four failed passwords in one 15-minute window.
    const testDatabase = createTestDatabase("task-6-window-boundary")
    const database = openTestDatabase(testDatabase.path)
    let now = STARTED_AT
    const handlers = createAdminAuthHandlers({
      allowedOrigin: ADMIN_ORIGIN,
      clock: { now: () => now },
      passwordHash: PASSWORD_HASH,
      runtime: database.runtime,
      secureCookies: false,
      sessionSecret: SESSION_SECRET,
    })

    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await handlers.login(loginRequest("wrong"))
      }

      // When: another failure occurs exactly 15 minutes after the first.
      now = STARTED_AT + ADMIN_LOGIN_WINDOW_MS
      const response = await handlers.login(loginRequest("wrong"))

      // Then: it is the first failure of a new window, not a lock.
      expect(response.status).toBe(401)
      expect(database.runtime.getAdminLoginState()).toEqual({
        failedAttempts: 1,
        lockedUntil: null,
        updatedAt: now,
        windowStartedAt: now,
      })
    } finally {
      database.close()
      testDatabase.cleanup()
    }
  })
})
