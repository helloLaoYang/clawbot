// @vitest-environment node

import { randomUUID } from "node:crypto"

import { describe, expect, it } from "vitest"

import { EpochMillisecondsSchema } from "../db/ids"
import { assertResultKind, createAdmissionCommand, createQueueHarness } from "../queue/test-support"

describe("terminal rate result persistence", () => {
  it("stores the exact integer Retry-After with a local terminal 429", () => {
    // Given: a one-per-minute bot whose last slot makes the next job miss its budget.
    const harness = createQueueHarness({
      label: "task-9-terminal-rate-persistence",
      configuredRate: 1,
    })
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

    try {
      // When: current rate eligibility leaves no 15-second attempt budget.
      const result = harness.queue.prepareAttempt({
        jobId: claim.job.id,
        ownerId,
        leaseGeneration: claim.job.leaseGeneration,
        serviceFence: harness.serviceFence,
        currentCeiling: harness.currentCeiling,
      })

      // Then: both the returned and persisted terminal Retry-After equal 60 seconds.
      assertResultKind(result, "terminal")
      expect(result).toMatchObject({ httpStatus: 429, retryAfter: 60 })
      const invocation = harness.handle.client
        .prepare<[], { readonly responseRetryAfter: number | null }>(
          "SELECT response_retry_after AS responseRetryAfter FROM invocations",
        )
        .get()
      expect(invocation?.responseRetryAfter).toBe(60)
    } finally {
      harness.cleanup()
    }
  })
})
