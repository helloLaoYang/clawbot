// @vitest-environment node

import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"

import { describe, expect, it } from "vitest"

import { BearerHashSchema, SessionSecretSchema } from "../config/config"
import { createAdminSession } from "../crypto/admin-auth"
import { hashBearer } from "../crypto/bearer"
import { BotPublicIdSchema } from "../db/ids"
import { createBotInput, createTestDatabase, openTestDatabase } from "../db/test-support/fixtures"
import { ADMIN_SESSION_COOKIE_NAME, authenticateAdminSession } from "./admin"
import {
  authenticateAdminBearer,
  authenticateBotBearer,
  type CredentialAuthentication,
} from "./bearers"

const ADMIN_BEARER = "A".repeat(43)
const BOT_BEARER = "B".repeat(43)
const OTHER_BEARER = "C".repeat(43)
const ADMIN_BEARER_HASH = BearerHashSchema.parse(hashBearer(ADMIN_BEARER))
const SESSION_SECRET = SessionSecretSchema.parse(Buffer.alloc(32, 71).toString("base64"))
const NOW = 1_710_000_000_000

function bearerRequest(bearer: string, cookie?: string): Request {
  const headers = new Headers({ authorization: `Bearer ${bearer}` })
  if (cookie !== undefined) {
    headers.set("cookie", cookie)
  }
  return new Request("http://localhost:3000/api/v1/auth-probe", { headers })
}

function unauthorizedResponse(authentication: CredentialAuthentication): Response {
  if (authentication.kind === "unauthorized") {
    return authentication.response
  }
  throw new TypeError("expected credential rejection")
}

async function expectGenericBearerRejection(response: Response): Promise<void> {
  expect(response.status).toBe(401)
  expect(response.headers.get("www-authenticate")).toBe("Bearer")
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(response.headers.get("access-control-allow-origin")).toBeNull()
  await expect(response.json()).resolves.toMatchObject({
    error: { code: "unauthorized", retryable: false },
  })
}

describe("isolated Bearer authenticators", () => {
  it("returns the same generic challenge for an unknown bot and a bad bot bearer", async () => {
    // Given: one persisted bot with a hashed webhook bearer.
    const testDatabase = createTestDatabase("task-6-generic-bot-auth")
    const database = openTestDatabase(testDatabase.path)
    const bot = createBotInput()
    database.bots.create({ ...bot, webhookBearerHash: hashBearer(BOT_BEARER) })
    const unknownBotId = BotPublicIdSchema.parse(randomUUID())

    try {
      // When: one request names no bot and another supplies the wrong bearer for a real bot.
      const unknown = authenticateBotBearer(bearerRequest(BOT_BEARER), unknownBotId, database.bots)
      const badBearer = authenticateBotBearer(
        bearerRequest(OTHER_BEARER),
        bot.publicId,
        database.bots,
      )

      // Then: both failures expose only the same Bearer authentication contract.
      await expectGenericBearerRejection(unauthorizedResponse(unknown))
      await expectGenericBearerRejection(unauthorizedResponse(badBearer))
    } finally {
      database.close()
      testDatabase.cleanup()
    }
  })

  it("authenticates the configured administrator bearer independently", () => {
    // Given: a request carrying the configured administrator API credential.
    const request = bearerRequest(ADMIN_BEARER)

    // When: the administrator Bearer authenticator checks it.
    const authentication = authenticateAdminBearer(request, ADMIN_BEARER_HASH)

    // Then: the credential is accepted without consulting browser session state.
    expect(authentication).toEqual({ kind: "authenticated" })
  })

  it("authenticates a per-bot bearer only for its persisted bot", () => {
    // Given: one persisted bot and its own webhook bearer hash.
    const testDatabase = createTestDatabase("task-6-valid-bot-auth")
    const database = openTestDatabase(testDatabase.path)
    const bot = createBotInput()
    database.bots.create({ ...bot, webhookBearerHash: hashBearer(BOT_BEARER) })

    try {
      // When: its bearer is checked against its public identifier.
      const authentication = authenticateBotBearer(
        bearerRequest(BOT_BEARER),
        bot.publicId,
        database.bots,
      )

      // Then: only that bot identity is returned.
      expect(authentication).toMatchObject({ kind: "authenticated", bot: { id: bot.id } })
    } finally {
      database.close()
      testDatabase.cleanup()
    }
  })

  it("cross-rejects browser, administrator, and bot credentials", async () => {
    // Given: three valid credentials from three isolated authentication domains.
    const testDatabase = createTestDatabase("task-6-cross-auth")
    const database = openTestDatabase(testDatabase.path)
    const bot = createBotInput()
    database.bots.create({ ...bot, webhookBearerHash: hashBearer(BOT_BEARER) })
    const session = createAdminSession(SESSION_SECRET, NOW)
    const sessionCookie = `${ADMIN_SESSION_COOKIE_NAME}=${session.token}`

    try {
      // When: every credential is replayed into a different authentication domain.
      const cookieAsAdminBearer = authenticateAdminBearer(
        bearerRequest(session.token),
        ADMIN_BEARER_HASH,
      )
      const botAsAdminBearer = authenticateAdminBearer(bearerRequest(BOT_BEARER), ADMIN_BEARER_HASH)
      const adminAsBotBearer = authenticateBotBearer(
        bearerRequest(ADMIN_BEARER),
        bot.publicId,
        database.bots,
      )
      const cookieAsBotBearer = authenticateBotBearer(
        bearerRequest(session.token),
        bot.publicId,
        database.bots,
      )
      const adminBearerWithNoSession = authenticateAdminSession(
        bearerRequest(ADMIN_BEARER),
        SESSION_SECRET,
        NOW,
      )
      const cookieDoesNotSubstituteForAdminBearer = authenticateAdminBearer(
        new Request("http://localhost:3000/api/v1/admin/messages/batch", {
          headers: { cookie: sessionCookie },
        }),
        ADMIN_BEARER_HASH,
      )

      // Then: every cross-domain replay receives the generic rejection.
      await expectGenericBearerRejection(unauthorizedResponse(cookieAsAdminBearer))
      await expectGenericBearerRejection(unauthorizedResponse(botAsAdminBearer))
      await expectGenericBearerRejection(unauthorizedResponse(adminAsBotBearer))
      await expectGenericBearerRejection(unauthorizedResponse(cookieAsBotBearer))
      expect(adminBearerWithNoSession.kind).toBe("unauthorized")
      await expectGenericBearerRejection(
        unauthorizedResponse(cookieDoesNotSubstituteForAdminBearer),
      )
    } finally {
      database.close()
      testDatabase.cleanup()
    }
  })
})
