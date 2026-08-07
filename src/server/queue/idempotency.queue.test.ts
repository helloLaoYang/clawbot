// @vitest-environment node

import { createHash, randomUUID } from "node:crypto"

import { describe, expect, it } from "vitest"

import { BotPublicIdSchema } from "../db/ids"
import { createBatchRequestDigest, createSingleRequestDigest } from "../db/repositories/queue"
import { assertResultKind, createAdmissionCommand, createQueueHarness } from "./test-support"

const IDEMPOTENCY_TTL_MS = 86_400_000

type IdempotencyRow = {
  readonly idempotencyScope: string
  readonly idempotencyKeyHash: string
  readonly requestDigest: string
}

function lengthPrefix(value: string): Buffer {
  const encoded = Buffer.from(value, "utf8")
  const length = Buffer.alloc(8)
  length.writeBigUInt64BE(BigInt(encoded.byteLength))
  return Buffer.concat([length, encoded])
}

function expectedSingleDigest(recipient: string, text: string): string {
  return createHash("sha256")
    .update(
      Buffer.concat([
        Buffer.from("clawbot-idem-v1:single", "ascii"),
        lengthPrefix(recipient),
        lengthPrefix(text),
      ]),
    )
    .digest("hex")
}

function expectedBatchDigest(botIds: readonly string[], recipient: string, text: string): string {
  const count = Buffer.alloc(4)
  count.writeUInt32BE(botIds.length)
  return createHash("sha256")
    .update(
      Buffer.concat([
        Buffer.from("clawbot-idem-v1:batch", "ascii"),
        count,
        ...botIds.map(lengthPrefix),
        lengthPrefix(recipient),
        lengthPrefix(text),
      ]),
    )
    .digest("hex")
}

describe("durable queue idempotency", () => {
  it("replays an identical active request and rejects a different canonical body", () => {
    // Given: one active single invocation with a caller idempotency key.
    const harness = createQueueHarness({ label: "task-9-idempotency-active" })
    const command = createAdmissionCommand(harness, { idempotencyKey: "stable-key" })
    const admitted = harness.queue.admit(command)
    assertResultKind(admitted, "admitted")

    try {
      // When: fresh transport identities repeat the same body and then change only its text.
      const replayed = harness.queue.admit(
        createAdmissionCommand(harness, { idempotencyKey: "stable-key" }),
      )
      const conflict = harness.queue.admit(
        createAdmissionCommand(harness, {
          idempotencyKey: "stable-key",
          text: "different canonical body",
        }),
      )

      // Then: the original invocation is reused and the length-prefixed digest is durable.
      assertResultKind(replayed, "replayed_in_flight")
      assertResultKind(conflict, "idempotency_conflict")
      expect(replayed.invocationId).toBe(command.invocationId)
      const row = harness.handle.client
        .prepare<[], IdempotencyRow>(`SELECT
          idempotency_scope AS idempotencyScope,
          idempotency_key_hash AS idempotencyKeyHash,
          request_digest AS requestDigest
        FROM invocations`)
        .get()
      expect(row).toEqual({
        idempotencyScope: `single:${harness.bot.id}`,
        idempotencyKeyHash: createHash("sha256").update("stable-key", "utf8").digest("hex"),
        requestDigest: expectedSingleDigest(command.recipient, command.text),
      })
    } finally {
      harness.cleanup()
    }
  })

  it("expires an idempotency record at the exact 24-hour boundary", () => {
    // Given: one active invocation and an otherwise identical replay just before expiry.
    const harness = createQueueHarness({ label: "task-9-idempotency-expiry" })
    const createdAt = harness.clock.now()
    const command = createAdmissionCommand(harness, { idempotencyKey: "expiring-key" })
    const admitted = harness.queue.admit(command)
    assertResultKind(admitted, "admitted")
    harness.clock.set(createdAt + IDEMPOTENCY_TTL_MS - 1)
    const active = harness.queue.admit(
      createAdmissionCommand(harness, { idempotencyKey: "expiring-key" }),
    )
    assertResultKind(active, "replayed_in_flight")

    try {
      // When: the same key is submitted at created_at plus exactly 86,400,000ms.
      harness.clock.set(createdAt + IDEMPOTENCY_TTL_MS)
      const replacementCommand = createAdmissionCommand(harness, {
        idempotencyKey: "expiring-key",
      })
      const replacement = harness.queue.admit(replacementCommand)

      // Then: expiry deletion and replacement occur in one transaction under the same key.
      assertResultKind(replacement, "admitted")
      expect(replacement.job.invocationId).toBe(replacementCommand.invocationId)
      const rows = harness.handle.client
        .prepare<[], { readonly count: number }>("SELECT count(*) AS count FROM invocations")
        .get()
      expect(rows?.count).toBe(1)
    } finally {
      harness.cleanup()
    }
  })

  it("restores a terminal response byte-for-byte", () => {
    // Given: an idempotent job completed by a valid fenced first-generation lease.
    const harness = createQueueHarness({ label: "task-9-idempotency-terminal" })
    const command = createAdmissionCommand(harness, { idempotencyKey: "terminal-key" })
    const admission = harness.queue.admit(command)
    assertResultKind(admission, "admitted")
    const workerId = randomUUID()
    const claim = harness.queue.claim({
      botId: harness.bot.id,
      ownerId: workerId,
      serviceFence: harness.serviceFence,
    })
    assertResultKind(claim, "claimed")
    const started = harness.queue.prepareAttempt({
      jobId: claim.job.id,
      ownerId: workerId,
      leaseGeneration: claim.job.leaseGeneration,
      serviceFence: harness.serviceFence,
      currentCeiling: harness.currentCeiling,
    })
    assertResultKind(started, "started")
    const responseBody = '{"status":"succeeded","message_id":"clawbot-stable"}'
    const finalized = harness.queue.finalizeSuccess({
      jobId: claim.job.id,
      ownerId: workerId,
      leaseGeneration: claim.job.leaseGeneration,
      attempt: started.attempt,
      serviceFence: harness.serviceFence,
      messageId: claim.job.clientId,
      responseHttpStatus: 200,
      responseBody,
      responseRetryAfter: null,
    })
    expect(finalized).toBe(true)

    try {
      // When: the same canonical request is replayed with fresh invocation and job IDs.
      const replay = harness.queue.admit(
        createAdmissionCommand(harness, { idempotencyKey: "terminal-key" }),
      )

      // Then: the stored status, bytes, and nullable Retry-After are returned unchanged.
      assertResultKind(replay, "replayed_terminal")
      expect(replay.response).toEqual({
        httpStatus: 200,
        body: responseBody,
        retryAfter: null,
      })
    } finally {
      harness.cleanup()
    }
  })

  it("uses injective ordered preimages for single and batch requests", () => {
    // Given: field pairs that collide under concatenation and two ordered batch bot IDs.
    const firstBot = BotPublicIdSchema.parse("00000000-0000-4000-8000-000000000001")
    const secondBot = BotPublicIdSchema.parse("00000000-0000-4000-8000-000000000002")

    // When: canonical digests are computed from length-prefixed UTF-8 fields.
    const firstSingle = createSingleRequestDigest("ab", "c")
    const secondSingle = createSingleRequestDigest("a", "bc")
    const batch = createBatchRequestDigest([firstBot, secondBot], "recipient@im.wechat", "text")
    const reversed = createBatchRequestDigest([secondBot, firstBot], "recipient@im.wechat", "text")

    // Then: field boundaries and requested bot order remain part of the exact digest contract.
    expect(firstSingle).not.toBe(secondSingle)
    expect(batch).toBe(expectedBatchDigest([firstBot, secondBot], "recipient@im.wechat", "text"))
    expect(batch).not.toBe(reversed)
  })
})
