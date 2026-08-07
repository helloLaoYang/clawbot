// @vitest-environment node

import { randomUUID } from "node:crypto"

import { describe, expect, it } from "vitest"

import { EpochMillisecondsSchema } from "../db/ids"
import { openTestDatabase } from "../db/test-support/fixtures"
import {
  assertResultKind,
  createAdmissionCommand,
  createQueueHarness,
  type QueueHarness,
} from "../queue/test-support"

type CooldownCase = {
  readonly name: string
  readonly retryAfter: string | null
  readonly expectedDelay: number
}

const COOLDOWN_CASES: readonly CooldownCase[] = [
  { name: "delta-seconds", retryAfter: "1", expectedDelay: 1_000 },
  { name: "large-delta-clamped", retryAfter: "999999", expectedDelay: 900_000 },
  { name: "missing-fallback", retryAfter: null, expectedDelay: 60_000 },
  { name: "zero-fallback", retryAfter: "0", expectedDelay: 60_000 },
  {
    name: "past-date-fallback",
    retryAfter: new Date(1_799_999_999_000).toUTCString(),
    expectedDelay: 60_000,
  },
  {
    name: "future-http-date",
    retryAfter: new Date(1_800_000_045_000).toUTCString(),
    expectedDelay: 45_000,
  },
] as const

function startAttempt(harness: QueueHarness): {
  readonly ownerId: string
  readonly jobId: ReturnType<typeof createAdmissionCommand>["jobId"]
  readonly leaseGeneration: number
  readonly attempt: number
} {
  const admission = harness.queue.admit(createAdmissionCommand(harness))
  assertResultKind(admission, "admitted")
  const ownerId = randomUUID()
  const claim = harness.queue.claim({
    botId: harness.bot.id,
    ownerId,
    serviceFence: harness.serviceFence,
  })
  assertResultKind(claim, "claimed")
  const started = harness.queue.prepareAttempt({
    jobId: claim.job.id,
    ownerId,
    leaseGeneration: claim.job.leaseGeneration,
    serviceFence: harness.serviceFence,
    currentCeiling: harness.currentCeiling,
  })
  assertResultKind(started, "started")
  return {
    ownerId,
    jobId: claim.job.id,
    leaseGeneration: claim.job.leaseGeneration,
    attempt: started.attempt,
  }
}

describe("persisted adaptive cooldown", () => {
  it("parses both Retry-After formats and clamps or falls back exactly", () => {
    // Given: independent first rate-limit outcomes across the supported header classes.
    for (const testCase of COOLDOWN_CASES) {
      const harness = createQueueHarness({ label: `task-9-cooldown-${testCase.name}` })
      const started = startAttempt(harness)
      const now = harness.clock.now()

      try {
        // When: HTTP 429 or ret=-2 records its optional Retry-After value.
        const result = harness.queue.recordFailure({
          jobId: started.jobId,
          ownerId: started.ownerId,
          leaseGeneration: started.leaseGeneration,
          attempt: started.attempt,
          serviceFence: harness.serviceFence,
          classification: "rate_limited",
          httpStatus: 429,
          tencentRet: null,
          backoffMs: 1_000,
          retryAfter: testCase.retryAfter,
        })

        // Then: cooldown and absolute retry timestamp match the clamped policy.
        assertResultKind(result, "recorded")
        expect(result.cooldownUntil).toBe(now + testCase.expectedDelay)
        expect(result.retryNotBefore).toBe(now + testCase.expectedDelay)
        expect(result.consecutiveRateLimits).toBe(1)
      } finally {
        harness.cleanup()
      }
    }
  })

  it("doubles invalid-header fallback to fifteen minutes and survives restart", () => {
    // Given: a bot with four persisted consecutive rate limits before another started attempt.
    const harness = createQueueHarness({ label: "task-9-cooldown-escalation" })
    const now = harness.clock.now()
    harness.handle.state.saveRate({
      botId: harness.bot.id,
      lastAttemptAt: null,
      nextEligibleAt: EpochMillisecondsSchema.parse(0),
      cooldownUntil: EpochMillisecondsSchema.parse(0),
      consecutiveRateLimits: 4,
      updatedAt: now,
    })
    const started = startAttempt(harness)

    try {
      // When: the fifth compatible rate limit has no valid future Retry-After.
      const result = harness.queue.recordFailure({
        jobId: started.jobId,
        ownerId: started.ownerId,
        leaseGeneration: started.leaseGeneration,
        attempt: started.attempt,
        serviceFence: harness.serviceFence,
        classification: "rate_limited",
        httpStatus: null,
        tencentRet: -2,
        backoffMs: 1_000,
        retryAfter: "invalid",
      })
      assertResultKind(result, "recorded")
      harness.handle.close()
      const restarted = openRestartedRateState(harness)

      // Then: exponential fallback caps at 15 minutes and remains durable after restart.
      expect(result.cooldownUntil).toBe(now + 900_000)
      expect(restarted).toMatchObject({
        consecutiveRateLimits: 5,
        cooldownUntil: now + 900_000,
      })
    } finally {
      harness.testDatabase.cleanup()
    }
  })

  it("keeps rate history on ordinary failure and resets it only for ret=0", () => {
    // Given: a bot with persisted rate history and an ordinary network failure.
    const harness = createQueueHarness({ label: "task-9-rate-reset" })
    const now = harness.clock.now()
    harness.handle.state.saveRate({
      botId: harness.bot.id,
      lastAttemptAt: null,
      nextEligibleAt: EpochMillisecondsSchema.parse(0),
      cooldownUntil: EpochMillisecondsSchema.parse(0),
      consecutiveRateLimits: 3,
      updatedAt: now,
    })
    const failedAttempt = startAttempt(harness)
    const failed = harness.queue.recordFailure({
      jobId: failedAttempt.jobId,
      ownerId: failedAttempt.ownerId,
      leaseGeneration: failedAttempt.leaseGeneration,
      attempt: failedAttempt.attempt,
      serviceFence: harness.serviceFence,
      classification: "network",
      httpStatus: null,
      tencentRet: null,
      backoffMs: 2_000,
      retryAfter: null,
    })
    assertResultKind(failed, "recorded")
    expect(failed.retryNotBefore).toBe(now + 2_000)
    expect(harness.handle.state.getRate(harness.bot.id)?.consecutiveRateLimits).toBe(3)
    harness.clock.advance(2_000)
    const retryOwnerId = randomUUID()
    const retryClaim = harness.queue.claim({
      botId: harness.bot.id,
      ownerId: retryOwnerId,
      serviceFence: harness.serviceFence,
    })
    assertResultKind(retryClaim, "claimed")
    const retryAttempt = harness.queue.prepareAttempt({
      jobId: retryClaim.job.id,
      ownerId: retryOwnerId,
      leaseGeneration: retryClaim.job.leaseGeneration,
      serviceFence: harness.serviceFence,
      currentCeiling: harness.currentCeiling,
    })
    assertResultKind(retryAttempt, "started")

    try {
      // When: the retried HTTP attempt completes with the only reset outcome, ret=0.
      const reset = harness.queue.finalizeSuccess({
        jobId: retryClaim.job.id,
        ownerId: retryOwnerId,
        leaseGeneration: retryClaim.job.leaseGeneration,
        attempt: retryAttempt.attempt,
        serviceFence: harness.serviceFence,
        messageId: retryClaim.job.clientId,
        responseHttpStatus: 200,
        responseBody: "success",
        responseRetryAfter: null,
      })

      // Then: both adaptive counter and cooldown reset while the consumed slot remains.
      expect(reset).toBe(true)
      expect(harness.handle.state.getRate(harness.bot.id)).toMatchObject({
        consecutiveRateLimits: 0,
        cooldownUntil: 0,
        lastAttemptAt: harness.clock.now(),
      })
    } finally {
      harness.cleanup()
    }
  })
})

function openRestartedRateState(harness: QueueHarness) {
  const restarted = openTestDatabase(harness.testDatabase.path)
  try {
    return restarted.state.getRate(harness.bot.id)
  } finally {
    restarted.close()
  }
}
