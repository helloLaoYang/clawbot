// @vitest-environment node

import { randomUUID } from "node:crypto"

import { describe, expect, it } from "vitest"

import { assertResultKind, createAdmissionCommand, createQueueHarness } from "./test-support"

describe("deadline lease ordering", () => {
  it("does not terminalize an attempt while its renewed lease is active", () => {
    // Given: an in-flight attempt whose lease was renewed beyond the job deadline.
    const harness = createQueueHarness({ label: "task-9-active-at-deadline" })
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
    for (const advance of [25_000, 25_000]) {
      harness.clock.advance(advance)
      expect(
        harness.queue.renewLease({
          jobId: claim.job.id,
          ownerId,
          leaseGeneration: claim.job.leaseGeneration,
          serviceFence: harness.serviceFence,
          abortController: new AbortController(),
        }),
      ).toBe(true)
    }
    harness.clock.set(claim.job.deadlineAt)

    try {
      // When: a competing worker probes the queue at the deadline.
      const result = harness.queue.claim({
        botId: harness.bot.id,
        ownerId: randomUUID(),
        serviceFence: harness.serviceFence,
      })

      // Then: the active owner remains authoritative until its lease CAS resolves.
      assertResultKind(result, "blocked")
      expect(harness.queue.findJob(claim.job.id)?.status).toBe("leased")
      const attempt = harness.handle.client
        .prepare<[string], { readonly classification: string }>(
          "SELECT classification FROM attempts WHERE job_id = ?",
        )
        .get(claim.job.id)
      expect(attempt?.classification).toBe("in_flight")
    } finally {
      harness.cleanup()
    }
  })

  it("abandons an expired in-flight attempt before deadline terminalization", () => {
    // Given: an in-flight attempt whose lease and deadline have both elapsed.
    const harness = createQueueHarness({ label: "task-9-expired-at-deadline" })
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
    harness.clock.set(claim.job.deadlineAt)

    try {
      // When: a new worker recovers the expired head at its deadline.
      const result = harness.queue.claim({
        botId: harness.bot.id,
        ownerId: randomUUID(),
        serviceFence: harness.serviceFence,
      })

      // Then: uncertainty is recorded as abandoned before the job becomes deadline-exceeded.
      assertResultKind(result, "blocked")
      expect(harness.queue.findJob(claim.job.id)?.status).toBe("deadline_exceeded")
      const attempt = harness.handle.client
        .prepare<
          [string],
          { readonly classification: string; readonly completedAt: number | null }
        >("SELECT classification, completed_at AS completedAt FROM attempts WHERE job_id = ?")
        .get(claim.job.id)
      expect(attempt).toEqual({ classification: "abandoned", completedAt: harness.clock.now() })
    } finally {
      harness.cleanup()
    }
  })
})
