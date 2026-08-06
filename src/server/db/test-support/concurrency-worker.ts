import { randomUUID } from "node:crypto"

import { z } from "zod"

import { BotIdSchema, EpochMillisecondsSchema } from "../ids"
import { createContextInput, openTestDatabase } from "./fixtures"

const WorkerCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("contexts"),
    databasePath: z.string().min(1),
    botId: BotIdSchema,
    offset: z.number().int().nonnegative(),
    count: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("claim"),
    databasePath: z.string().min(1),
    botId: BotIdSchema,
    now: EpochMillisecondsSchema,
    leaseUntil: EpochMillisecondsSchema,
  }),
])

const serializedCommand = process.argv[2]
if (serializedCommand === undefined) {
  throw new TypeError("worker command is required")
}
const command = WorkerCommandSchema.parse(JSON.parse(serializedCommand))
const handle = openTestDatabase(command.databasePath)

try {
  switch (command.kind) {
    case "contexts": {
      for (let index = 0; index < command.count; index += 1) {
        handle.contexts.upsert(createContextInput(command.botId, command.offset + index))
      }
      process.stdout.write(JSON.stringify({ kind: command.kind, completed: command.count }))
      break
    }
    case "claim": {
      const job = handle.queue.claimNext({
        botId: command.botId,
        ownerId: randomUUID(),
        now: command.now,
        leaseUntil: command.leaseUntil,
      })
      process.stdout.write(JSON.stringify({ kind: command.kind, jobId: job?.id ?? null }))
      break
    }
    default: {
      command satisfies never
    }
  }
} finally {
  handle.close()
}
