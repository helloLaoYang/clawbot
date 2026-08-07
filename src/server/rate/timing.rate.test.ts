// @vitest-environment node

import { randomUUID } from "node:crypto"

import { describe, expect, it } from "vitest"

import { EpochMillisecondsSchema } from "../db/ids"
import { assertResultKind, createAdmissionCommand, createQueueHarness } from "../queue/test-support"

const INTERVAL_CASES = [
  { configured: 1, ceiling: 600, expected: 60_000 },
  { configured: 2, ceiling: 600, expected: 30_000 },
  { configured: 3, ceiling: 600, expected: 20_000 },
  { configured: 7, ceiling: 600, expected: 8_572 },
  { configured: 600, ceiling: 7, expected: 8_572 },
  { configured: 600, ceiling: 600, expected: 100 },
] as const

describe("per-bot rate timing", () => {
  it("uses ceil(60000/min(configured,current ceiling)) for every attempt", () => {
    // Given: property cases spanning configured and environment ceiling bottlenecks.
    for (const testCase of INTERVAL_CASES) {
      const harness = createQueueHarness({
        label: `task-9-interval-${testCase.configured}-${testCase.ceiling}`,
        configuredRate: testCase.configured,
        currentCeiling: testCase.ceiling,
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
        // When: an attempt recomputes eligibility from the current ceiling.
        const result = harness.queue.prepareAttempt({
          jobId: claim.job.id,
          ownerId,
          leaseGeneration: claim.job.leaseGeneration,
          serviceFence: harness.serviceFence,
          currentCeiling: testCase.ceiling,
        })

        // Then: interval and max-formula eligibility equal the mathematical property.
        expect(result.kind === "deferred" || result.kind === "terminal").toBe(true)
        if (result.kind === "deferred" || result.kind === "terminal") {
          expect(result.intervalMs).toBe(testCase.expected)
          expect(result.eligibleAt).toBe(now + testCase.expected)
        }
      } finally {
        harness.cleanup()
      }
    }
  })

  it("persists a future rate wait without consuming another slot", () => {
    // Given: one successful attempt at six sends per minute and a second leased FIFO job.
    const harness = createQueueHarness({ label: "task-9-persisted-wait", configuredRate: 6 })
    const first = harness.queue.admit(createAdmissionCommand(harness))
    assertResultKind(first, "admitted")
    const firstOwner = randomUUID()
    const firstClaim = harness.queue.claim({
      botId: harness.bot.id,
      ownerId: firstOwner,
      serviceFence: harness.serviceFence,
    })
    assertResultKind(firstClaim, "claimed")
    const firstAttempt = harness.queue.prepareAttempt({
      jobId: firstClaim.job.id,
      ownerId: firstOwner,
      leaseGeneration: firstClaim.job.leaseGeneration,
      serviceFence: harness.serviceFence,
      currentCeiling: harness.currentCeiling,
    })
    assertResultKind(firstAttempt, "started")
    expect(
      harness.queue.finalizeSuccess({
        jobId: firstClaim.job.id,
        ownerId: firstOwner,
        leaseGeneration: firstClaim.job.leaseGeneration,
        attempt: firstAttempt.attempt,
        serviceFence: harness.serviceFence,
        messageId: firstClaim.job.clientId,
        responseHttpStatus: 200,
        responseBody: "success",
        responseRetryAfter: null,
      }),
    ).toBe(true)
    const second = harness.queue.admit(createAdmissionCommand(harness))
    assertResultKind(second, "admitted")
    const secondOwner = randomUUID()
    const secondClaim = harness.queue.claim({
      botId: harness.bot.id,
      ownerId: secondOwner,
      serviceFence: harness.serviceFence,
    })
    assertResultKind(secondClaim, "claimed")

    try {
      // When: attempt two is evaluated before the persisted ten-second slot boundary.
      const result = harness.queue.prepareAttempt({
        jobId: secondClaim.job.id,
        ownerId: secondOwner,
        leaseGeneration: secondClaim.job.leaseGeneration,
        serviceFence: harness.serviceFence,
        currentCeiling: harness.currentCeiling,
      })

      // Then: it becomes absolute retry_wait, clears its lease, and inserts no attempt.
      assertResultKind(result, "deferred")
      expect(result.eligibleAt).toBe(harness.clock.now() + 10_000)
      expect(harness.queue.findJob(secondClaim.job.id)).toMatchObject({
        status: "retry_wait",
        retryNotBefore: harness.clock.now() + 10_000,
        ownerId: null,
        leaseUntil: null,
      })
      const rows = harness.handle.client
        .prepare<[], { readonly count: number }>("SELECT count(*) AS count FROM attempts")
        .get()
      expect(rows?.count).toBe(1)
    } finally {
      harness.cleanup()
    }
  })

  it("slows down immediately when the environment ceiling decreases", () => {
    // Given: one slot consumed at 600/minute and a second job claimed immediately afterward.
    const harness = createQueueHarness({ label: "task-9-ceiling-decrease", configuredRate: 600 })
    const first = harness.queue.admit(createAdmissionCommand(harness))
    assertResultKind(first, "admitted")
    const firstOwner = randomUUID()
    const firstClaim = harness.queue.claim({
      botId: harness.bot.id,
      ownerId: firstOwner,
      serviceFence: harness.serviceFence,
    })
    assertResultKind(firstClaim, "claimed")
    const firstAttempt = harness.queue.prepareAttempt({
      jobId: firstClaim.job.id,
      ownerId: firstOwner,
      leaseGeneration: firstClaim.job.leaseGeneration,
      serviceFence: harness.serviceFence,
      currentCeiling: 600,
    })
    assertResultKind(firstAttempt, "started")
    expect(
      harness.queue.finalizeSuccess({
        jobId: firstClaim.job.id,
        ownerId: firstOwner,
        leaseGeneration: firstClaim.job.leaseGeneration,
        attempt: firstAttempt.attempt,
        serviceFence: harness.serviceFence,
        messageId: firstClaim.job.clientId,
        responseHttpStatus: 200,
        responseBody: "success",
        responseRetryAfter: null,
      }),
    ).toBe(true)
    const second = harness.queue.admit(createAdmissionCommand(harness))
    assertResultKind(second, "admitted")
    const secondOwner = randomUUID()
    const secondClaim = harness.queue.claim({
      botId: harness.bot.id,
      ownerId: secondOwner,
      serviceFence: harness.serviceFence,
    })
    assertResultKind(secondClaim, "claimed")

    try {
      // When: the current environment ceiling drops from 600 to two before attempt start.
      const result = harness.queue.prepareAttempt({
        jobId: secondClaim.job.id,
        ownerId: secondOwner,
        leaseGeneration: secondClaim.job.leaseGeneration,
        serviceFence: harness.serviceFence,
        currentCeiling: 2,
      })

      // Then: the persisted wait immediately expands to the new 30-second interval.
      assertResultKind(result, "deferred")
      expect(result.intervalMs).toBe(30_000)
      expect(result.eligibleAt).toBe(harness.clock.now() + 30_000)
    } finally {
      harness.cleanup()
    }
  })

  it("chooses 429 for rate-driven exhaustion and 504 for backoff-only exhaustion", () => {
    // Given: one rate-driven job and one independent job with only absolute retry backoff.
    const rateHarness = createQueueHarness({ label: "task-9-terminal-429", configuredRate: 1 })
    const rateNow = rateHarness.clock.now()
    rateHarness.handle.state.saveRate({
      botId: rateHarness.bot.id,
      lastAttemptAt: rateNow,
      nextEligibleAt: EpochMillisecondsSchema.parse(0),
      cooldownUntil: EpochMillisecondsSchema.parse(0),
      consecutiveRateLimits: 0,
      updatedAt: rateNow,
    })
    const rateAdmission = rateHarness.queue.admit(createAdmissionCommand(rateHarness))
    assertResultKind(rateAdmission, "admitted")
    const rateOwner = randomUUID()
    const rateClaim = rateHarness.queue.claim({
      botId: rateHarness.bot.id,
      ownerId: rateOwner,
      serviceFence: rateHarness.serviceFence,
    })
    assertResultKind(rateClaim, "claimed")

    try {
      // When: both jobs have insufficient post-eligibility time for another HTTP attempt.
      const rateResult = rateHarness.queue.prepareAttempt({
        jobId: rateClaim.job.id,
        ownerId: rateOwner,
        leaseGeneration: rateClaim.job.leaseGeneration,
        serviceFence: rateHarness.serviceFence,
        currentCeiling: rateHarness.currentCeiling,
      })

      // Then: the rate-driven boundary is terminal 429 with its exact integer Retry-After.
      assertResultKind(rateResult, "terminal")
      expect(rateResult.httpStatus).toBe(429)
      expect(rateResult.retryAfter).toBe(60)
    } finally {
      rateHarness.cleanup()
    }

    const backoffHarness = createQueueHarness({ label: "task-9-terminal-504" })
    const backoffAdmission = backoffHarness.queue.admit(createAdmissionCommand(backoffHarness))
    assertResultKind(backoffAdmission, "admitted")
    const backoffOwner = randomUUID()
    const backoffClaim = backoffHarness.queue.claim({
      botId: backoffHarness.bot.id,
      ownerId: backoffOwner,
      serviceFence: backoffHarness.serviceFence,
    })
    assertResultKind(backoffClaim, "claimed")
    backoffHarness.handle.client
      .prepare<[number, string]>("UPDATE jobs SET retry_not_before = ? WHERE id = ?")
      .run(backoffClaim.job.deadlineAt, backoffClaim.job.id)

    try {
      const backoffResult = backoffHarness.queue.prepareAttempt({
        jobId: backoffClaim.job.id,
        ownerId: backoffOwner,
        leaseGeneration: backoffClaim.job.leaseGeneration,
        serviceFence: backoffHarness.serviceFence,
        currentCeiling: backoffHarness.currentCeiling,
      })
      assertResultKind(backoffResult, "terminal")
      expect(backoffResult.httpStatus).toBe(504)
      expect(backoffResult.retryAfter).toBeNull()
    } finally {
      backoffHarness.cleanup()
    }
  })
})
