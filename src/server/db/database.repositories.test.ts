// @vitest-environment node

import { randomUUID } from "node:crypto"

import { describe, expect, it } from "vitest"

import { EpochMillisecondsSchema, InvocationIdSchema } from "./ids"
import {
  createAdmissionInput,
  createBotInput,
  createTestDatabase,
  openTestDatabase,
} from "./test-support/fixtures"

type CountRow = { readonly count: number }

describe("database repositories", () => {
  it("rolls back invocation admission when its job insert fails", () => {
    // Given: one admitted job and a second invocation reusing its job ID.
    const testDatabase = createTestDatabase("task-4-admission")
    const handle = openTestDatabase(testDatabase.path)
    const bot = createBotInput()
    handle.bots.create(bot)
    const existing = createAdmissionInput(bot)
    handle.queue.admitSingle(existing)
    const rejectedInvocationId = InvocationIdSchema.parse(randomUUID())
    const rejected = createAdmissionInput(bot)

    try {
      // When: the second transaction violates the job primary key.
      expect(() =>
        handle.queue.admitSingle({
          invocation: { ...rejected.invocation, id: rejectedInvocationId },
          job: { ...rejected.job, id: existing.job.id },
        }),
      ).toThrowError(/UNIQUE constraint failed/)

      // Then: its parent invocation was rolled back too.
      const row = handle.client
        .prepare<[string], CountRow>("SELECT count(*) AS count FROM invocations WHERE id = ?")
        .get(rejectedInvocationId)
      expect(row?.count).toBe(0)
    } finally {
      handle.close()
      testDatabase.cleanup()
    }
  })

  it("claims the oldest eligible job once and increments its lease generation", () => {
    // Given: two eligible jobs ordered by creation time and two database connections.
    const testDatabase = createTestDatabase("task-4-claim")
    const firstHandle = openTestDatabase(testDatabase.path)
    const bot = createBotInput()
    firstHandle.bots.create(bot)
    const firstAdmission = createAdmissionInput(bot, 1_800_000_000_100)
    const secondAdmission = createAdmissionInput(bot, 1_800_000_000_200)
    firstHandle.queue.admitSingle(firstAdmission)
    firstHandle.queue.admitSingle(secondAdmission)
    const secondHandle = openTestDatabase(testDatabase.path)

    try {
      // When: competing repository connections claim the queue.
      const firstClaim = firstHandle.queue.claimNext({
        botId: bot.id,
        ownerId: randomUUID(),
        now: firstAdmission.job.createdAt,
        leaseUntil: firstAdmission.job.deadlineAt,
      })
      const secondClaim = secondHandle.queue.claimNext({
        botId: bot.id,
        ownerId: randomUUID(),
        now: secondAdmission.job.createdAt,
        leaseUntil: secondAdmission.job.deadlineAt,
      })

      // Then: the oldest job has one first-generation owner and blocks the next job.
      expect(firstClaim).toMatchObject({ id: firstAdmission.job.id, leaseGeneration: 1 })
      expect(secondClaim).toBeNull()
    } finally {
      secondHandle.close()
      firstHandle.close()
      testDatabase.cleanup()
    }
  })

  it("persists encrypted inbound cursor and exact rate state across restart", () => {
    // Given: a bot with initialized inbound and rate rows.
    const testDatabase = createTestDatabase("task-4-bot-state")
    const first = openTestDatabase(testDatabase.path)
    const bot = createBotInput()
    first.bots.create(bot)
    const updatedAt = EpochMillisecondsSchema.parse(1_800_000_000_500)

    try {
      // When: typed state is saved and the database restarts.
      first.state.saveInbound({
        botId: bot.id,
        cursor: "opaque-upstream-cursor",
        lastPolledAt: updatedAt,
        updatedAt,
      })
      first.state.saveRate({
        botId: bot.id,
        lastAttemptAt: updatedAt,
        nextEligibleAt: EpochMillisecondsSchema.parse(1_800_000_010_500),
        cooldownUntil: EpochMillisecondsSchema.parse(1_800_000_020_500),
        consecutiveRateLimits: 3,
        updatedAt,
      })
      first.close()
      const restarted = openTestDatabase(testDatabase.path)

      try {
        // Then: callers receive decrypted cursor data and exact rate fields.
        expect(restarted.state.getInbound(bot.id)).toEqual({
          botId: bot.id,
          cursor: "opaque-upstream-cursor",
          lastPolledAt: updatedAt,
          updatedAt,
        })
        expect(restarted.state.getRate(bot.id)).toEqual({
          botId: bot.id,
          lastAttemptAt: updatedAt,
          nextEligibleAt: 1_800_000_010_500,
          cooldownUntil: 1_800_000_020_500,
          consecutiveRateLimits: 3,
          updatedAt,
        })
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
})
