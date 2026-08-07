// @vitest-environment node

import { Buffer } from "node:buffer"

import { describe, expect, it } from "vitest"

import { AdminPasswordHashSchema, SessionSecretSchema } from "../config/config"
import { createTestDatabase, openTestDatabase } from "../db/test-support/fixtures"
import { ADMIN_SESSION_COOKIE_NAME, type AdminAuthHandlers, createAdminAuthHandlers } from "./admin"

const ADMIN_ORIGIN = "http://localhost:3000"
const ADMIN_PASSWORD = "correct horse battery staple"
const PASSWORD_HASH = AdminPasswordHashSchema.parse(
  "scrypt$v1$32768$8$1$AAECAwQFBgcICQoLDA0ODw$eo40JB24mNWRdcaWU4xBdGepdf_laQaEJfFhiNMVnFg",
)
const SESSION_SECRET = SessionSecretSchema.parse(Buffer.alloc(32, 71).toString("base64"))
const STARTED_AT = 1_710_000_000_000

type AuthHarness = {
  readonly cleanup: () => void
  readonly handlers: AdminAuthHandlers
  readonly setNow: (value: number) => void
}

function createHarness(label: string, secureCookies = false): AuthHarness {
  const testDatabase = createTestDatabase(label)
  const database = openTestDatabase(testDatabase.path)
  let now = STARTED_AT
  return {
    cleanup: () => {
      database.close()
      testDatabase.cleanup()
    },
    handlers: createAdminAuthHandlers({
      allowedOrigin: ADMIN_ORIGIN,
      clock: { now: () => now },
      passwordHash: PASSWORD_HASH,
      runtime: database.runtime,
      secureCookies,
      sessionSecret: SESSION_SECRET,
    }),
    setNow: (value) => {
      now = value
    },
  }
}

function createLoginRequest(body: string, origin: string | null = ADMIN_ORIGIN): Request {
  const headers = new Headers({ "content-type": "application/json" })
  if (origin !== null) {
    headers.set("origin", origin)
  }
  return new Request("http://localhost:3000/api/admin/auth/login", {
    body,
    headers,
    method: "POST",
  })
}

function cookiePair(setCookie: string): string {
  const pair = setCookie.split(";", 1).at(0)
  if (pair === undefined) {
    throw new TypeError("Set-Cookie did not contain a cookie pair")
  }
  return pair
}

describe("administrator browser sessions", () => {
  it("logs in, reads the signed session, and logs out with strict cookie attributes", async () => {
    // Given: a clean persisted login state and the configured administrator password.
    const harness = createHarness("task-6-session-flow")

    try {
      // When: the browser logs in with the exact allowed Origin.
      const login = await harness.handlers.login(
        createLoginRequest(JSON.stringify({ password: ADMIN_PASSWORD })),
      )

      // Then: a no-store, HttpOnly, eight-hour Strict cookie authenticates the session route.
      expect(login.status).toBe(204)
      expect(login.headers.get("cache-control")).toBe("no-store")
      expect(login.headers.get("access-control-allow-origin")).toBeNull()
      const setCookie = login.headers.get("set-cookie") ?? ""
      expect(setCookie).toContain(`${ADMIN_SESSION_COOKIE_NAME}=`)
      expect(setCookie).toContain("HttpOnly")
      expect(setCookie).toContain("SameSite=Strict")
      expect(setCookie).toContain("Max-Age=28800")
      expect(setCookie).toContain("Path=/")
      expect(setCookie).not.toContain("Secure")

      const cookie = cookiePair(setCookie)
      const session = harness.handlers.session(
        new Request("http://localhost:3000/api/admin/session", {
          headers: { cookie },
        }),
      )
      expect(session.status).toBe(200)
      await expect(session.json()).resolves.toEqual({
        authenticated: true,
        expires_at: STARTED_AT + 8 * 60 * 60 * 1_000,
      })

      const logout = harness.handlers.logout(
        new Request("http://localhost:3000/api/admin/auth/logout", {
          headers: { cookie, origin: ADMIN_ORIGIN },
          method: "POST",
        }),
      )
      expect(logout.status).toBe(204)
      expect(logout.headers.get("set-cookie")).toContain("Max-Age=0")
    } finally {
      harness.cleanup()
    }
  })

  it("marks the session cookie Secure in production mode", async () => {
    // Given: the same handler configured for production cookies.
    const harness = createHarness("task-6-secure-cookie", true)

    try {
      // When: the administrator logs in.
      const response = await harness.handlers.login(
        createLoginRequest(JSON.stringify({ password: ADMIN_PASSWORD })),
      )

      // Then: the browser cookie is explicitly Secure.
      expect(response.headers.get("set-cookie")).toContain("Secure")
    } finally {
      harness.cleanup()
    }
  })

  it("clears an invalid session cookie on logout", () => {
    // Given: a browser carrying a stale administrator cookie from the allowed Origin.
    const harness = createHarness("task-6-stale-logout")

    try {
      // When: the browser logs out without an authenticated session.
      const response = harness.handlers.logout(
        new Request("http://localhost:3000/api/admin/auth/logout", {
          headers: {
            cookie: `${ADMIN_SESSION_COOKIE_NAME}=invalid`,
            origin: ADMIN_ORIGIN,
          },
          method: "POST",
        }),
      )

      // Then: logout remains idempotent and removes the stale cookie.
      expect(response.status).toBe(204)
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0")
    } finally {
      harness.cleanup()
    }
  })

  it.each([
    ["missing", null],
    ["different", "http://attacker.example"],
  ] as const)("rejects a %s Origin before checking credentials", async (_label, origin) => {
    // Given: a syntactically valid login body from an untrusted browser origin.
    const harness = createHarness(`task-6-origin-${_label}`)

    try {
      // When: the write omits or changes the configured Origin.
      const response = await harness.handlers.login(
        createLoginRequest(JSON.stringify({ password: ADMIN_PASSWORD }), origin),
      )

      // Then: it fails generically without setting a session or CORS policy.
      expect(response.status).toBe(403)
      expect(response.headers.get("set-cookie")).toBeNull()
      expect(response.headers.get("access-control-allow-origin")).toBeNull()
      await expect(response.json()).resolves.toMatchObject({ error: { code: "unauthorized" } })
    } finally {
      harness.cleanup()
    }
  })

  it("rejects malformed login JSON without exposing credential details", async () => {
    // Given: an allowed browser write with malformed JSON.
    const harness = createHarness("task-6-invalid-json")

    try {
      // When: the login handler parses the body.
      const response = await harness.handlers.login(createLoginRequest("{"))

      // Then: the boundary returns the fixed invalid-json code and no cookie.
      expect(response.status).toBe(400)
      expect(response.headers.get("set-cookie")).toBeNull()
      await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_json" } })
    } finally {
      harness.cleanup()
    }
  })

  it("rejects tampered and exactly expired session cookies generically", async () => {
    // Given: one valid signed administrator session.
    const harness = createHarness("task-6-invalid-session")

    try {
      const login = await harness.handlers.login(
        createLoginRequest(JSON.stringify({ password: ADMIN_PASSWORD })),
      )
      const cookie = cookiePair(login.headers.get("set-cookie") ?? "")
      const [name, token] = cookie.split("=", 2)
      if (name === undefined || token === undefined) {
        throw new TypeError("login cookie was malformed")
      }
      const last = token.at(-1) === "A" ? "B" : "A"
      const tamperedCookie = `${name}=${token.slice(0, -1)}${last}`

      // When: a tampered token and the original token at its exact expiry are presented.
      const tampered = harness.handlers.session(
        new Request("http://localhost:3000/api/admin/session", {
          headers: { cookie: tamperedCookie },
        }),
      )
      harness.setNow(STARTED_AT + 8 * 60 * 60 * 1_000)
      const expired = harness.handlers.session(
        new Request("http://localhost:3000/api/admin/session", { headers: { cookie } }),
      )

      // Then: neither failure distinguishes its cause or emits a Bearer challenge.
      expect(tampered.status).toBe(401)
      expect(expired.status).toBe(401)
      expect(tampered.headers.get("www-authenticate")).toBeNull()
      await expect(tampered.json()).resolves.toMatchObject({ error: { code: "unauthorized" } })
      await expect(expired.json()).resolves.toMatchObject({ error: { code: "unauthorized" } })
    } finally {
      harness.cleanup()
    }
  })
})
