// @vitest-environment node

import { randomUUID } from "node:crypto"

import { describe, expect, it } from "vitest"

import { assertResultKind, createAdmissionCommand, createQueueHarness } from "./test-support"

type AttemptRow = {
  readonly attempt: number
  readonly classification: string
  readonly completedAt: number | null
}

describe("FIFO job leases", () => {
  it("blocks behind the head and abandons its stale in-flight attempt on reclaim", () => {
    // Given: two ordered jobs and an in-flight attempt held by the first worker.
    const harness = createQueueHarness({ label: "task-9-fifo-reclaim" })
    const firstAdmission = harness.queue.admit(createAdmissionCommand(harness))
    assertResultKind(firstAdmission, "admitted")
    harness.clock.advance(1)
    const secondAdmission = harness.queue.admit(createAdmissionCommand(harness))
    assertResultKind(secondAdmission, "admitted")
    const firstOwner = randomUUID()
    const firstClaim = harness.queue.claim({
      botId: harness.bot.id,
      ownerId: firstOwner,
      serviceFence: harness.serviceFence,
    })
    assertResultKind(firstClaim, "claimed")
    const started = harness.queue.prepareAttempt({
      jobId: firstClaim.job.id,
      ownerId: firstOwner,
      leaseGeneration: firstClaim.job.leaseGeneration,
      serviceFence: harness.serviceFence,
      currentCeiling: harness.currentCeiling,
    })
    assertResultKind(started, "started")

    try {
      // When: another owner probes before expiry and again at the exact 30-second boundary.
      const blocked = harness.queue.claim({
        botId: harness.bot.id,
        ownerId: randomUUID(),
        serviceFence: harness.serviceFence,
      })
      harness.clock.advance(30_000)
      const reclaimed = harness.queue.claim({
        botId: harness.bot.id,
        ownerId: randomUUID(),
        serviceFence: harness.serviceFence,
      })

      // Then: FIFO never skips the head, generation increments, and attempt one is abandoned.
      assertResultKind(blocked, "blocked")
      assertResultKind(reclaimed, "claimed")
      expect(reclaimed.job.id).toBe(firstAdmission.job.id)
      expect(reclaimed.job.id).not.toBe(secondAdmission.job.id)
      expect(reclaimed.job.leaseGeneration).toBe(2)
      const attempts = harness.handle.client
        .prepare<[], AttemptRow>(`SELECT
          attempt,
          classification,
          completed_at AS completedAt
        FROM attempts ORDER BY attempt`)
        .all()
      expect(attempts).toEqual([
        { attempt: 1, classification: "abandoned", completedAt: harness.clock.now() },
      ])
    } finally {
      harness.cleanup()
    }
  })

  it("renews by owner and generation and aborts immediately on CAS loss", () => {
    // Given: one claimed job and an AbortController owned by its worker task.
    const harness = createQueueHarness({ label: "task-9-lease-renewal" })
    const admission = harness.queue.admit(createAdmissionCommand(harness))
    assertResultKind(admission, "admitted")
    const ownerId = randomUUID()
    const claim = harness.queue.claim({
      botId: harness.bot.id,
      ownerId,
      serviceFence: harness.serviceFence,
    })
    assertResultKind(claim, "claimed")
    harness.clock.advance(5_000)
    const liveController = new AbortController()

    try {
      // When: the current owner renews and a stale generation then tries the same operation.
      const renewed = harness.queue.renewLease({
        jobId: claim.job.id,
        ownerId,
        leaseGeneration: claim.job.leaseGeneration,
        serviceFence: harness.serviceFence,
        abortController: liveController,
      })
      const staleController = new AbortController()
      const stale = harness.queue.renewLease({
        jobId: claim.job.id,
        ownerId,
        leaseGeneration: claim.job.leaseGeneration - 1,
        serviceFence: harness.serviceFence,
        abortController: staleController,
      })

      // Then: the live lease extends 30 seconds and stale work is synchronously cancelled.
      expect(renewed).toBe(true)
      expect(liveController.signal.aborted).toBe(false)
      expect(harness.queue.findJob(claim.job.id)?.leaseUntil).toBe(harness.clock.now() + 30_000)
      expect(stale).toBe(false)
      expect(staleController.signal.aborted).toBe(true)
    } finally {
      harness.cleanup()
    }
  })

  it("forbids stale finalization after ownership transfers", () => {
    // Given: attempt one started under generation one and reclaimed under generation two.
    const harness = createQueueHarness({ label: "task-9-stale-finalize" })
    const admission = harness.queue.admit(createAdmissionCommand(harness))
    assertResultKind(admission, "admitted")
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
    harness.clock.advance(30_000)
    const secondOwner = randomUUID()
    const reclaimed = harness.queue.claim({
      botId: harness.bot.id,
      ownerId: secondOwner,
      serviceFence: harness.serviceFence,
    })
    assertResultKind(reclaimed, "claimed")

    try {
      // When: generation one attempts to commit success after the ownership transfer.
      const staleFinalize = harness.queue.finalizeSuccess({
        jobId: firstClaim.job.id,
        ownerId: firstOwner,
        leaseGeneration: firstClaim.job.leaseGeneration,
        attempt: firstAttempt.attempt,
        serviceFence: harness.serviceFence,
        messageId: firstClaim.job.clientId,
        responseHttpStatus: 200,
        responseBody: "stale",
        responseRetryAfter: null,
      })

      // Then: no stale attempt or job result is written.
      expect(staleFinalize).toBe(false)
      expect(harness.queue.findJob(firstClaim.job.id)).toMatchObject({
        ownerId: secondOwner,
        leaseGeneration: 2,
        status: "leased",
      })
      const row = harness.handle.client
        .prepare<[], AttemptRow>(`SELECT
          attempt,
          classification,
          completed_at AS completedAt
        FROM attempts WHERE attempt = 1`)
        .get()
      expect(row?.classification).toBe("abandoned")
    } finally {
      harness.cleanup()
    }
  })

  it("starts no HTTP attempt at or after the committed deadline", () => {
    // Given: one leased job whose 60-second committed deadline is known.
    const harness = createQueueHarness({ label: "task-9-no-late-attempt" })
    const admission = harness.queue.admit(createAdmissionCommand(harness))
    assertResultKind(admission, "admitted")
    const ownerId = randomUUID()
    const claim = harness.queue.claim({
      botId: harness.bot.id,
      ownerId,
      serviceFence: harness.serviceFence,
    })
    assertResultKind(claim, "claimed")
    harness.clock.advance(25_000)
    expect(
      harness.queue.renewLease({
        jobId: claim.job.id,
        ownerId,
        leaseGeneration: claim.job.leaseGeneration,
        serviceFence: harness.serviceFence,
        abortController: new AbortController(),
      }),
    ).toBe(true)
    harness.clock.advance(25_000)
    expect(
      harness.queue.renewLease({
        jobId: claim.job.id,
        ownerId,
        leaseGeneration: claim.job.leaseGeneration,
        serviceFence: harness.serviceFence,
        abortController: new AbortController(),
      }),
    ).toBe(true)
    harness.clock.set(claim.job.deadlineAt)

    try {
      // When: the worker asks to start at the exact deadline boundary.
      const result = harness.queue.prepareAttempt({
        jobId: claim.job.id,
        ownerId,
        leaseGeneration: claim.job.leaseGeneration,
        serviceFence: harness.serviceFence,
        currentCeiling: harness.currentCeiling,
      })

      // Then: the job terminalizes as 504 and no in-flight attempt row exists.
      assertResultKind(result, "terminal")
      expect(result.httpStatus).toBe(504)
      expect(harness.queue.findJob(claim.job.id)?.status).toBe("deadline_exceeded")
      const attempts = harness.handle.client
        .prepare<[], { readonly count: number }>("SELECT count(*) AS count FROM attempts")
        .get()
      expect(attempts?.count).toBe(0)
    } finally {
      harness.cleanup()
    }
  })
})
