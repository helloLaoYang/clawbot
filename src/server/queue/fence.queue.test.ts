// @vitest-environment node

import { randomUUID } from "node:crypto"

import { describe, expect, it } from "vitest"

import { assertResultKind, createAdmissionCommand, createQueueHarness } from "./test-support"

function replaceServiceOwner(harness: ReturnType<typeof createQueueHarness>): void {
  harness.handle.client
    .prepare<[string, number]>(`UPDATE service_lease
      SET owner_id = ?, fencing_token = fencing_token + 1, updated_at = ?
      WHERE name = 'primary'`)
    .run(randomUUID(), harness.clock.now())
}

describe("queue service fencing", () => {
  it("rejects a claim after the service owner loses its fence", () => {
    // Given: one queued job and a service lease replaced by another process owner.
    const harness = createQueueHarness({ label: "task-9-fenced-claim" })
    const admission = harness.queue.admit(createAdmissionCommand(harness))
    assertResultKind(admission, "admitted")
    replaceServiceOwner(harness)

    try {
      // When: the stale service owner attempts a new job claim.
      const result = harness.queue.claim({
        botId: harness.bot.id,
        ownerId: randomUUID(),
        serviceFence: harness.serviceFence,
      })

      // Then: no ownership or generation write occurs.
      assertResultKind(result, "service_fence_lost")
      expect(harness.queue.findJob(admission.job.id)).toMatchObject({
        status: "queued",
        ownerId: null,
        leaseGeneration: 0,
      })
    } finally {
      harness.cleanup()
    }
  })

  it("performs no attempt or rate write after service fence loss", () => {
    // Given: a valid job lease followed by replacement of the singleton service owner.
    const harness = createQueueHarness({ label: "task-9-fenced-attempt" })
    const admission = harness.queue.admit(createAdmissionCommand(harness))
    assertResultKind(admission, "admitted")
    const ownerId = randomUUID()
    const claim = harness.queue.claim({
      botId: harness.bot.id,
      ownerId,
      serviceFence: harness.serviceFence,
    })
    assertResultKind(claim, "claimed")
    replaceServiceOwner(harness)

    try {
      // When: the stale service owner attempts to reserve an HTTP slot.
      const result = harness.queue.prepareAttempt({
        jobId: claim.job.id,
        ownerId,
        leaseGeneration: claim.job.leaseGeneration,
        serviceFence: harness.serviceFence,
        currentCeiling: harness.currentCeiling,
      })

      // Then: attempt count and per-bot rate state remain untouched.
      assertResultKind(result, "service_fence_lost")
      expect(harness.queue.findJob(claim.job.id)?.attemptCount).toBe(0)
      expect(harness.handle.state.getRate(harness.bot.id)).toMatchObject({
        lastAttemptAt: null,
        nextEligibleAt: 0,
      })
    } finally {
      harness.cleanup()
    }
  })

  it("aborts renewal immediately after service fence loss", () => {
    // Given: a claimed job whose singleton service owner has been replaced.
    const harness = createQueueHarness({ label: "task-9-fenced-renewal" })
    const admission = harness.queue.admit(createAdmissionCommand(harness))
    assertResultKind(admission, "admitted")
    const ownerId = randomUUID()
    const claim = harness.queue.claim({
      botId: harness.bot.id,
      ownerId,
      serviceFence: harness.serviceFence,
    })
    assertResultKind(claim, "claimed")
    replaceServiceOwner(harness)
    const abortController = new AbortController()

    try {
      // When: its five-second renewal path observes the failed service-fence CAS.
      const renewed = harness.queue.renewLease({
        jobId: claim.job.id,
        ownerId,
        leaseGeneration: claim.job.leaseGeneration,
        serviceFence: harness.serviceFence,
        abortController,
      })

      // Then: renewal fails and the in-flight transport signal is synchronously aborted.
      expect(renewed).toBe(false)
      expect(abortController.signal.aborted).toBe(true)
    } finally {
      harness.cleanup()
    }
  })
})
