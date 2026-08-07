// @vitest-environment node

import { describe, expect, it } from "vitest"

import { EpochMillisecondsSchema } from "../db/ids"
import { assertResultKind, createAdmissionCommand, createQueueHarness } from "./test-support"

type CountRow = { readonly count: number }

describe("durable queue admission", () => {
  it("uses rows as the only capacity reservation and rejects job 101", () => {
    // Given: a 600-per-minute bot whose 100 FIFO rows fit the 60-second deadline.
    const harness = createQueueHarness({ label: "task-9-capacity", configuredRate: 600 })

    try {
      // When: one hundred jobs are admitted and a 101st competes for capacity.
      for (let index = 0; index < 100; index += 1) {
        const result = harness.queue.admit(createAdmissionCommand(harness))
        assertResultKind(result, "admitted")
        expect(result.job.admissionEstimatedAt).toBe(1_800_000_000_000 + index * 100)
        harness.clock.advance(1)
      }
      const overflow = harness.queue.admit(createAdmissionCommand(harness))

      // Then: only job rows reserve capacity and Retry-After uses the earliest deadline.
      assertResultKind(overflow, "queue_full")
      expect(overflow.retryAfter).toBe(60)
      expect(harness.handle.state.getRate(harness.bot.id)).toEqual({
        botId: harness.bot.id,
        lastAttemptAt: null,
        nextEligibleAt: 0,
        cooldownUntil: 0,
        consecutiveRateLimits: 0,
        updatedAt: 1_800_000_000_000,
      })
      const count = harness.handle.client
        .prepare<[], CountRow>("SELECT count(*) AS count FROM jobs")
        .get()
      expect(count?.count).toBe(100)
    } finally {
      harness.cleanup()
    }
  })

  it("rejects an estimate that leaves less than fifteen seconds", () => {
    // Given: a one-per-minute bot with one accepted row at the current instant.
    const harness = createQueueHarness({ label: "task-9-deadline-estimate", configuredRate: 1 })
    const first = harness.queue.admit(createAdmissionCommand(harness))
    assertResultKind(first, "admitted")

    try {
      // When: a second row would be estimated exactly at its 60-second deadline.
      const rejected = harness.queue.admit(createAdmissionCommand(harness))

      // Then: admission returns the clamped local Retry-After without consuming rate state.
      assertResultKind(rejected, "deadline_unavailable")
      expect(rejected.estimatedAt).toBe(1_800_000_060_000)
      expect(rejected.retryAfter).toBe(60)
      expect(harness.handle.state.getRate(harness.bot.id)?.lastAttemptAt).toBeNull()
      const count = harness.handle.client
        .prepare<[], CountRow>("SELECT count(*) AS count FROM jobs")
        .get()
      expect(count?.count).toBe(1)
    } finally {
      harness.cleanup()
    }
  })

  it("computes the exact max-formula without mutating persisted rate state", () => {
    // Given: persisted next-eligible and cooldown timestamps plus a six-per-minute bot.
    const harness = createQueueHarness({ label: "task-9-admission-formula", configuredRate: 6 })
    const now = harness.clock.now()
    harness.handle.state.saveRate({
      botId: harness.bot.id,
      lastAttemptAt: EpochMillisecondsSchema.parse(now - 1_000),
      nextEligibleAt: EpochMillisecondsSchema.parse(now + 5_000),
      cooldownUntil: EpochMillisecondsSchema.parse(now + 12_000),
      consecutiveRateLimits: 2,
      updatedAt: now,
    })

    try {
      // When: two rows are admitted in the same fake-clock instant.
      const first = harness.queue.admit(createAdmissionCommand(harness))
      const second = harness.queue.admit(createAdmissionCommand(harness))

      // Then: cooldown drives the head and the tail plus current interval drives its successor.
      assertResultKind(first, "admitted")
      assertResultKind(second, "admitted")
      expect(first.job.admissionEstimatedAt).toBe(now + 12_000)
      expect(second.job.admissionEstimatedAt).toBe(now + 22_000)
      expect(harness.handle.state.getRate(harness.bot.id)?.consecutiveRateLimits).toBe(2)
    } finally {
      harness.cleanup()
    }
  })

  it("rolls back the invocation when its job insert fails", () => {
    // Given: one non-idempotent job and another command reusing its job identity.
    const harness = createQueueHarness({ label: "task-9-admission-rollback" })
    const firstCommand = createAdmissionCommand(harness, { idempotencyKey: null })
    const admitted = harness.queue.admit(firstCommand)
    assertResultKind(admitted, "admitted")
    const conflicting = createAdmissionCommand(harness, {
      idempotencyKey: null,
      jobId: firstCommand.jobId,
    })

    try {
      // When: the second immediate transaction violates the durable job identity.
      expect(() => harness.queue.admit(conflicting)).toThrowError(/UNIQUE constraint failed/)

      // Then: no orphan invocation survives the failed transaction.
      const count = harness.handle.client
        .prepare<[], CountRow>("SELECT count(*) AS count FROM invocations")
        .get()
      expect(count?.count).toBe(1)
    } finally {
      harness.cleanup()
    }
  })
})
