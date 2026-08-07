import { randomUUID } from "node:crypto"

import type { CreateBotInput } from "../db/contracts"
import type { DatabaseHandle } from "../db/database"
import {
  type BotId,
  BotIdSchema,
  type EpochMilliseconds,
  EpochMillisecondsSchema,
  type InvocationId,
  InvocationIdSchema,
  type JobId,
  JobIdSchema,
} from "../db/ids"
import { DrizzleQueueRepository } from "../db/repositories/queue"
import {
  createBotInput,
  createTestCipher,
  createTestDatabase,
  openTestDatabase,
} from "../db/test-support/fixtures"

const SERVICE_LEASE_DURATION_MS = 172_800_000

export class FakeClock {
  private current: EpochMilliseconds

  constructor(now = 1_800_000_000_000) {
    this.current = EpochMillisecondsSchema.parse(now)
  }

  now(): EpochMilliseconds {
    return this.current
  }

  advance(milliseconds: number): void {
    this.current = EpochMillisecondsSchema.parse(this.current + milliseconds)
  }

  set(now: number): void {
    this.current = EpochMillisecondsSchema.parse(now)
  }
}

export type ServiceFenceFixture = {
  readonly ownerId: string
  readonly fencingToken: number
}

export type AdmissionCommandFixture = {
  readonly invocationId: InvocationId
  readonly requestId: InvocationId
  readonly jobId: JobId
  readonly botId: BotId
  readonly recipient: string
  readonly recipientLookupHash: string
  readonly userFingerprint: string
  readonly text: string
  readonly contextToken: string
  readonly idempotencyKey: string | null
  readonly currentCeiling: number
}

export type QueueHarness = {
  readonly testDatabase: ReturnType<typeof createTestDatabase>
  readonly handle: DatabaseHandle
  readonly queue: DrizzleQueueRepository
  readonly clock: FakeClock
  readonly bot: CreateBotInput
  readonly serviceFence: ServiceFenceFixture
  readonly currentCeiling: number
  readonly cleanup: () => void
}

export type QueueHarnessOptions = {
  readonly label: string
  readonly configuredRate?: number
  readonly currentCeiling?: number
}

class QueueTestFixtureError extends Error {
  readonly name = "QueueTestFixtureError"
}

export function createQueueHarness(options: QueueHarnessOptions): QueueHarness {
  const clock = new FakeClock()
  const testDatabase = createTestDatabase(options.label)
  const cipher = createTestCipher()
  const handle = openTestDatabase(testDatabase.path, cipher)
  const bot = {
    ...createBotInput(clock.now()),
    maxSendsPerMinute: options.configuredRate ?? 600,
  }
  handle.bots.create(bot)
  const ownerId = randomUUID()
  const serviceLease = handle.runtime.acquireServiceLease({
    ownerId,
    now: clock.now(),
    expiresAt: EpochMillisecondsSchema.parse(clock.now() + SERVICE_LEASE_DURATION_MS),
  })
  if (serviceLease === null) {
    throw new QueueTestFixtureError("service lease fixture could not be acquired")
  }
  const queue = new DrizzleQueueRepository(handle.orm, cipher, clock)
  return {
    testDatabase,
    handle,
    queue,
    clock,
    bot,
    serviceFence: { ownerId, fencingToken: serviceLease.fencingToken },
    currentCeiling: options.currentCeiling ?? 600,
    cleanup: () => {
      if (handle.client.open) {
        handle.close()
      }
      testDatabase.cleanup()
    },
  }
}

export function createAdmissionCommand(
  harness: QueueHarness,
  overrides: Partial<AdmissionCommandFixture> = {},
): AdmissionCommandFixture {
  const userFingerprint = harness.bot.boundUserFingerprint
  if (userFingerprint === null) {
    throw new QueueTestFixtureError("queue fixture requires a bound user")
  }
  return {
    invocationId: InvocationIdSchema.parse(randomUUID()),
    requestId: InvocationIdSchema.parse(randomUUID()),
    jobId: JobIdSchema.parse(randomUUID()),
    botId: BotIdSchema.parse(harness.bot.id),
    recipient: "recipient@im.wechat",
    recipientLookupHash: "b".repeat(64),
    userFingerprint,
    text: "Task 9 queue payload",
    contextToken: "context-token-task-9",
    idempotencyKey: `idem-${randomUUID()}`,
    currentCeiling: harness.currentCeiling,
    ...overrides,
  }
}

export function assertResultKind<
  Result extends { readonly kind: string },
  Kind extends Result["kind"],
>(result: Result, kind: Kind): asserts result is Extract<Result, { readonly kind: Kind }> {
  if (result.kind !== kind) {
    throw new QueueTestFixtureError(`expected ${kind}, received ${result.kind}`)
  }
}
