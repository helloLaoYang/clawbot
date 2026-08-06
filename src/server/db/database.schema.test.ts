// @vitest-environment node

import { randomUUID } from "node:crypto"

import { describe, expect, it } from "vitest"

import { InvocationIdSchema } from "./ids"
import {
  createAdmissionInput,
  createAttemptInput,
  createBotInput,
  createContextInput,
  createTestDatabase,
  openTestDatabase,
} from "./test-support/fixtures"

type IndexRow = { readonly name: string }
type CascadeCountRow = {
  readonly bots: number
  readonly botSecrets: number
  readonly contexts: number
  readonly inbound: number
  readonly rate: number
  readonly invocations: number
  readonly jobs: number
  readonly attempts: number
}

describe("database schema", () => {
  it("rejects invalid checked states and malformed UUID identifiers", () => {
    // Given: valid bot, invocation, job, and attempt rows.
    const testDatabase = createTestDatabase("task-4-checks")
    const handle = openTestDatabase(testDatabase.path)
    const bot = createBotInput()
    handle.bots.create(bot)
    const admission = createAdmissionInput(bot)
    handle.queue.admitSingle(admission)
    handle.queue.recordAttempt(createAttemptInput(admission.job.id))

    try {
      // When/Then: enum and UUID checks reject malformed persisted states.
      expect(() =>
        handle.client.prepare("UPDATE bots SET auth_status = 'unknown'").run(),
      ).toThrowError(/CHECK constraint failed/)
      expect(() =>
        handle.client.prepare("UPDATE jobs SET status = 'abandoned'").run(),
      ).toThrowError(/CHECK constraint failed/)
      expect(() =>
        handle.client.prepare("UPDATE attempts SET classification = 'queued'").run(),
      ).toThrowError(/CHECK constraint failed/)
      expect(() => handle.client.prepare("UPDATE bots SET id = 'not-a-uuid'").run()).toThrowError(
        /CHECK constraint failed/,
      )
      const malformedRequestId = `-${admission.invocation.requestId.slice(1)}`
      expect(() =>
        handle.client
          .prepare<[string, string]>("UPDATE invocations SET request_id = ? WHERE id = ?")
          .run(malformedRequestId, admission.invocation.id),
      ).toThrowError(/CHECK constraint failed/)
    } finally {
      handle.close()
      testDatabase.cleanup()
    }
  })

  it("enforces unique public, upstream, context, and idempotency identities", () => {
    // Given: one bot, context, and idempotent invocation.
    const testDatabase = createTestDatabase("task-4-unique")
    const handle = openTestDatabase(testDatabase.path)
    const bot = createBotInput()
    handle.bots.create(bot)
    const context = createContextInput(bot.id, 1)
    handle.contexts.upsert(context)
    const admission = createAdmissionInput(bot)
    handle.queue.admitSingle(admission)

    try {
      // When/Then: each logical identity has one durable owner.
      expect(() =>
        handle.bots.create({ ...createBotInput(), publicId: bot.publicId }),
      ).toThrowError(/UNIQUE constraint failed/)
      expect(() =>
        handle.bots.create({
          ...createBotInput(),
          ilinkBotIdLookupHash: bot.ilinkBotIdLookupHash,
        }),
      ).toThrowError(/UNIQUE constraint failed/)
      handle.contexts.upsert({ ...context, id: createContextInput(bot.id, 2).id })
      const contextCount = handle.client
        .prepare<[], { readonly count: number }>(
          "SELECT count(*) AS count FROM conversation_contexts",
        )
        .get()
      expect(contextCount?.count).toBe(1)
      expect(() =>
        handle.queue.admitSingle({
          ...createAdmissionInput(bot),
          invocation: {
            ...createAdmissionInput(bot).invocation,
            id: InvocationIdSchema.parse(randomUUID()),
            idempotencyScope: admission.invocation.idempotencyScope,
            idempotencyKeyHash: admission.invocation.idempotencyKeyHash,
          },
        }),
      ).toThrowError(/UNIQUE constraint failed/)
    } finally {
      handle.close()
      testDatabase.cleanup()
    }
  })

  it("cascades bot deletion through all bot-owned records", () => {
    // Given: a bot with secrets, cursor/rate state, context, invocation, job, and attempt.
    const testDatabase = createTestDatabase("task-4-cascade")
    const handle = openTestDatabase(testDatabase.path)
    const bot = createBotInput()
    handle.bots.create(bot)
    handle.contexts.upsert(createContextInput(bot.id, 1))
    const admission = createAdmissionInput(bot)
    handle.queue.admitSingle(admission)
    handle.queue.recordAttempt(createAttemptInput(admission.job.id))

    try {
      // When: the owning bot is deleted.
      handle.bots.delete(bot.id)

      // Then: no bot-owned row survives the foreign-key cascades.
      const counts = handle.client
        .prepare<[], CascadeCountRow>(`SELECT
          (SELECT count(*) FROM bots) AS bots,
          (SELECT count(*) FROM bot_secrets) AS botSecrets,
          (SELECT count(*) FROM conversation_contexts) AS contexts,
          (SELECT count(*) FROM inbound_state) AS inbound,
          (SELECT count(*) FROM rate_state) AS rate,
          (SELECT count(*) FROM invocations) AS invocations,
          (SELECT count(*) FROM jobs) AS jobs,
          (SELECT count(*) FROM attempts) AS attempts`)
        .get()
      expect(counts).toEqual({
        bots: 0,
        botSecrets: 0,
        contexts: 0,
        inbound: 0,
        rate: 0,
        invocations: 0,
        jobs: 0,
        attempts: 0,
      })
    } finally {
      handle.close()
      testDatabase.cleanup()
    }
  })

  it("creates the FIFO, idempotency, context, and claim indexes", () => {
    // Given: a migrated database.
    const testDatabase = createTestDatabase("task-4-indexes")
    const handle = openTestDatabase(testDatabase.path)

    try {
      // When: durable index metadata is inspected.
      const indexes = handle.client
        .prepare<[], IndexRow>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map(({ name }) => name)

      // Then: competing operations have their required lookup order.
      expect(indexes).toEqual(
        expect.arrayContaining([
          "conversation_contexts_bot_lookup_unique",
          "bots_upstream_lookup_unique",
          "invocations_idempotency_unique",
          "invocations_timeline_idx",
          "jobs_bot_fifo_idx",
          "jobs_bot_tail_idx",
        ]),
      )
    } finally {
      handle.close()
      testDatabase.cleanup()
    }
  })
})
