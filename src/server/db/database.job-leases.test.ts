// @vitest-environment node

import { randomUUID } from "node:crypto"

import { describe, expect, it } from "vitest"

import { EpochMillisecondsSchema } from "./ids"
import {
  createAdmissionInput,
  createBotInput,
  createTestDatabase,
  openTestDatabase,
} from "./test-support/fixtures"

describe("database job leases", () => {
  it("reclaims an expired head job with a new lease generation", () => {
    // Given: the FIFO head is leased by a first owner until a known boundary.
    const testDatabase = createTestDatabase("task-4-job-lease-expired")
    const handle = openTestDatabase(testDatabase.path)
    const bot = createBotInput()
    handle.bots.create(bot)
    const admission = createAdmissionInput(bot)
    handle.queue.admitSingle(admission)
    handle.queue.claimNext({
      botId: bot.id,
      ownerId: randomUUID(),
      now: admission.job.createdAt,
      leaseUntil: EpochMillisecondsSchema.parse(1_800_000_001_000),
    })
    const secondOwner = randomUUID()

    try {
      // When: another worker claims at the exact expiry boundary.
      const reclaimed = handle.queue.claimNext({
        botId: bot.id,
        ownerId: secondOwner,
        now: EpochMillisecondsSchema.parse(1_800_000_001_000),
        leaseUntil: EpochMillisecondsSchema.parse(1_800_000_002_000),
      })

      // Then: the same head transfers ownership under generation 2.
      expect(reclaimed).toMatchObject({
        id: admission.job.id,
        ownerId: secondOwner,
        leaseGeneration: 2,
        leaseUntil: 1_800_000_002_000,
      })
    } finally {
      handle.close()
      testDatabase.cleanup()
    }
  })
})
