// @vitest-environment node

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import { JobIdSchema } from "./ids"
import {
  createAdmissionInput,
  createBotInput,
  createTestDatabase,
  openTestDatabase,
} from "./test-support/fixtures"

const WorkerResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("contexts"), completed: z.number().int().positive() }),
  z.object({ kind: z.literal("claim"), jobId: JobIdSchema.nullable() }),
])

type WorkerCommand =
  | {
      readonly kind: "contexts"
      readonly databasePath: string
      readonly botId: string
      readonly offset: number
      readonly count: number
    }
  | {
      readonly kind: "claim"
      readonly databasePath: string
      readonly botId: string
      readonly now: number
      readonly leaseUntil: number
    }

class RepositoryWorkerError extends Error {
  readonly name = "RepositoryWorkerError"
}

const WORKER_PATH = fileURLToPath(new URL("./test-support/concurrency-worker.ts", import.meta.url))

function runWorker(command: WorkerCommand): Promise<z.infer<typeof WorkerResultSchema>> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", WORKER_PATH, JSON.stringify(command)],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new RepositoryWorkerError(`worker exited ${code}: ${stderr}`))
        return
      }
      resolve(WorkerResultSchema.parse(JSON.parse(stdout)))
    })
  })
}

describe("database concurrency", () => {
  it("completes 100 contended repository writes without SQLITE_BUSY", async () => {
    // Given: one bot and four independent SQLite writer processes.
    const testDatabase = createTestDatabase("task-4-concurrency")
    const handle = openTestDatabase(testDatabase.path)
    const bot = createBotInput()
    handle.bots.create(bot)

    try {
      // When: each process submits 25 immediate context upserts.
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, worker) =>
          runWorker({
            kind: "contexts",
            databasePath: testDatabase.path,
            botId: bot.id,
            offset: worker * 25,
            count: 25,
          }),
        ),
      )

      // Then: all 100 writes commit and no worker reports lock leakage.
      expect(results).toHaveLength(4)
      const row = handle.client
        .prepare<[], { readonly count: number }>(
          "SELECT count(*) AS count FROM conversation_contexts",
        )
        .get()
      expect(row?.count).toBe(100)
    } finally {
      handle.close()
      testDatabase.cleanup()
    }
  }, 20_000)

  it("allows exactly one process to claim a single eligible job", async () => {
    // Given: one queued job visible to two writer processes.
    const testDatabase = createTestDatabase("task-4-claim-concurrency")
    const handle = openTestDatabase(testDatabase.path)
    const bot = createBotInput()
    handle.bots.create(bot)
    const admission = createAdmissionInput(bot)
    handle.queue.admitSingle(admission)

    try {
      // When: both processes race the same immediate claim transaction.
      const results = await Promise.all([
        runWorker({
          kind: "claim",
          databasePath: testDatabase.path,
          botId: bot.id,
          now: admission.job.createdAt,
          leaseUntil: admission.job.deadlineAt,
        }),
        runWorker({
          kind: "claim",
          databasePath: testDatabase.path,
          botId: bot.id,
          now: admission.job.createdAt,
          leaseUntil: admission.job.deadlineAt,
        }),
      ])

      // Then: one owner wins and the other observes no eligible row.
      const claimed = results.flatMap((result) =>
        result.kind === "claim" && result.jobId !== null ? [result.jobId] : [],
      )
      expect(claimed).toEqual([admission.job.id])
    } finally {
      handle.close()
      testDatabase.cleanup()
    }
  }, 20_000)
})
