import { randomUUID } from "node:crypto"

import { z } from "zod"

import { BotIdSchema, EpochMillisecondsSchema } from "../db/ids"
import { DrizzleQueueRepository } from "../db/repositories/queue"
import { createTestCipher, openTestDatabase } from "../db/test-support/fixtures"

const ClaimWorkerCommandSchema = z.object({
  databasePath: z.string().min(1),
  botId: BotIdSchema,
  now: EpochMillisecondsSchema,
  serviceOwnerId: z.string().uuid(),
  fencingToken: z.number().int().positive(),
})

const serializedCommand = process.argv[2]
if (serializedCommand === undefined) {
  throw new TypeError("queue worker command is required")
}
const command = ClaimWorkerCommandSchema.parse(JSON.parse(serializedCommand))
const handle = openTestDatabase(command.databasePath)
const queue = new DrizzleQueueRepository(handle.orm, createTestCipher(), {
  now: () => command.now,
})

try {
  const result = queue.claim({
    botId: command.botId,
    ownerId: randomUUID(),
    serviceFence: {
      ownerId: command.serviceOwnerId,
      fencingToken: command.fencingToken,
    },
  })
  switch (result.kind) {
    case "claimed":
      process.stdout.write(JSON.stringify({ kind: result.kind, jobId: result.job.id }))
      break
    case "blocked":
    case "service_fence_lost":
      process.stdout.write(JSON.stringify({ kind: result.kind }))
      break
    default:
      result satisfies never
  }
} finally {
  handle.close()
}
