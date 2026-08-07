// @vitest-environment node

import { describe, expect, it } from "vitest"

import { createBotInput, createTestDatabase, openTestDatabase } from "./test-support/fixtures"

describe("QR bot repository confirmation", () => {
  it("creates bot-owned rows in one immediate transaction", () => {
    // Given: a complete new-bot confirmation input.
    const testDatabase = createTestDatabase("task-7-qr-repository-create")
    const database = openTestDatabase(testDatabase.path)
    const bot = createBotInput()

    try {
      // When: the QR repository confirms the new account.
      const result = database.qrBots.confirm({ bot, kind: "new" })

      // Then: the bot, secret, inbound, and rate rows commit together.
      expect(result).toMatchObject({ bot: { id: bot.id }, kind: "confirmed" })
      const counts = database.client
        .prepare<
          [],
          {
            readonly bots: number
            readonly inbound: number
            readonly rate: number
            readonly secrets: number
          }
        >(`SELECT
          (SELECT count(*) FROM bots) AS bots,
          (SELECT count(*) FROM bot_secrets) AS secrets,
          (SELECT count(*) FROM inbound_state) AS inbound,
          (SELECT count(*) FROM rate_state) AS rate`)
        .get()
      expect(counts).toEqual({ bots: 1, inbound: 1, rate: 1, secrets: 1 })
    } finally {
      database.close()
      testDatabase.cleanup()
    }
  })

  it("rolls back the bot row when its secret insert fails", () => {
    // Given: a database failure injected between bot and secret writes.
    const testDatabase = createTestDatabase("task-7-qr-repository-atomic")
    const database = openTestDatabase(testDatabase.path)
    database.client
      .prepare(`CREATE TRIGGER reject_qr_secret
        BEFORE INSERT ON bot_secrets
        BEGIN SELECT RAISE(ABORT, 'injected secret failure'); END`)
      .run()

    try {
      // When: confirmation reaches the injected secret failure.
      expect(() => database.qrBots.confirm({ bot: createBotInput(), kind: "new" })).toThrowError(
        /injected secret failure/,
      )

      // Then: no partial bot or secret row survives.
      const counts = database.client
        .prepare<[], { readonly bots: number; readonly secrets: number }>(
          "SELECT (SELECT count(*) FROM bots) AS bots, (SELECT count(*) FROM bot_secrets) AS secrets",
        )
        .get()
      expect(counts).toEqual({ bots: 0, secrets: 0 })
    } finally {
      database.close()
      testDatabase.cleanup()
    }
  })
})
