// @vitest-environment node

import { randomUUID } from "node:crypto"

import { describe, expect, it } from "vitest"

import { EpochMillisecondsSchema } from "../db/ids"
import { createBotInput } from "../db/test-support/fixtures"
import { assertResultKind, createAdmissionCommand, createQueueHarness } from "../queue/test-support"

describe("independent current per-bot rate state", () => {
  it("does not let one bot cooldown delay another bot", () => {
    // Given: two bots sharing one database while only the first has a future cooldown.
    const harness = createQueueHarness({ label: "task-9-independent-bots", configuredRate: 6 })
    const secondBot = { ...createBotInput(harness.clock.now()), maxSendsPerMinute: 6 }
    harness.handle.bots.create(secondBot)
    harness.handle.state.saveRate({
      botId: harness.bot.id,
      lastAttemptAt: null,
      nextEligibleAt: EpochMillisecondsSchema.parse(0),
      cooldownUntil: EpochMillisecondsSchema.parse(harness.clock.now() + 45_000),
      consecutiveRateLimits: 1,
      updatedAt: harness.clock.now(),
    })
    const secondFingerprint = secondBot.boundUserFingerprint
    if (secondFingerprint === null) {
      throw new TypeError("second bot fixture requires a bound user")
    }

    try {
      // When: both bots admit a row at the same fake-clock instant.
      const cooled = harness.queue.admit(createAdmissionCommand(harness))
      const independent = harness.queue.admit(
        createAdmissionCommand(harness, {
          botId: secondBot.id,
          userFingerprint: secondFingerprint,
        }),
      )

      // Then: only the first bot inherits its own persisted cooldown timestamp.
      assertResultKind(cooled, "admitted")
      assertResultKind(independent, "admitted")
      expect(cooled.job.admissionEstimatedAt).toBe(harness.clock.now() + 45_000)
      expect(independent.job.admissionEstimatedAt).toBe(harness.clock.now())
    } finally {
      harness.cleanup()
    }
  })

  it("re-reads a configured rate decrease immediately before attempt start", () => {
    // Given: a 600-per-minute bot with a slot consumed at the current instant.
    const harness = createQueueHarness({ label: "task-9-configured-decrease", configuredRate: 600 })
    const now = harness.clock.now()
    harness.handle.state.saveRate({
      botId: harness.bot.id,
      lastAttemptAt: now,
      nextEligibleAt: EpochMillisecondsSchema.parse(0),
      cooldownUntil: EpochMillisecondsSchema.parse(0),
      consecutiveRateLimits: 0,
      updatedAt: now,
    })
    const admission = harness.queue.admit(createAdmissionCommand(harness))
    assertResultKind(admission, "admitted")
    const ownerId = randomUUID()
    const claim = harness.queue.claim({
      botId: harness.bot.id,
      ownerId,
      serviceFence: harness.serviceFence,
    })
    assertResultKind(claim, "claimed")
    harness.handle.client
      .prepare<[number, string]>("UPDATE bots SET max_sends_per_minute = ? WHERE id = ?")
      .run(2, harness.bot.id)

    try {
      // When: eligibility is evaluated after the configured rate drops to two per minute.
      const result = harness.queue.prepareAttempt({
        jobId: claim.job.id,
        ownerId,
        leaseGeneration: claim.job.leaseGeneration,
        serviceFence: harness.serviceFence,
        currentCeiling: 600,
      })

      // Then: the current persisted configuration imposes a 30-second interval immediately.
      assertResultKind(result, "deferred")
      expect(result.intervalMs).toBe(30_000)
      expect(result.eligibleAt).toBe(now + 30_000)
    } finally {
      harness.cleanup()
    }
  })
})
