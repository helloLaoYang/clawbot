// @vitest-environment node

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"
import { z } from "zod"

import { JobIdSchema } from "../db/ids"
import { assertResultKind, createAdmissionCommand, createQueueHarness } from "./test-support"

const ClaimWorkerResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("claimed"), jobId: JobIdSchema }),
  z.object({ kind: z.literal("blocked") }),
  z.object({ kind: z.literal("service_fence_lost") }),
])

const WORKER_PATH = fileURLToPath(new URL("./concurrency-worker.ts", import.meta.url))

class QueueWorkerError extends Error {
  readonly name = "QueueWorkerError"
}

function runClaimWorker(command: {
  readonly databasePath: string
  readonly botId: string
  readonly now: number
  readonly serviceOwnerId: string
  readonly fencingToken: number
}): Promise<z.infer<typeof ClaimWorkerResultSchema>> {
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
        reject(new QueueWorkerError(`queue worker exited ${code}: ${stderr}`))
        return
      }
      resolve(ClaimWorkerResultSchema.parse(JSON.parse(stdout)))
    })
  })
}

describe("durable queue claim concurrency", () => {
  it("allows exactly one process to claim the FIFO head", async () => {
    // Given: one queued row and two isolated SQLite worker processes.
    const harness = createQueueHarness({ label: "task-9-rich-claim-concurrency" })
    const admission = harness.queue.admit(createAdmissionCommand(harness))
    assertResultKind(admission, "admitted")
    const command = {
      databasePath: harness.testDatabase.path,
      botId: harness.bot.id,
      now: harness.clock.now(),
      serviceOwnerId: harness.serviceFence.ownerId,
      fencingToken: harness.serviceFence.fencingToken,
    }

    try {
      // When: both processes enter independent immediate claim transactions.
      const results = await Promise.all([runClaimWorker(command), runClaimWorker(command)])

      // Then: one process owns generation one and the other observes head-of-line blocking.
      expect(results.map(({ kind }) => kind).sort()).toEqual(["blocked", "claimed"])
      const claimed = results.find((result) => result.kind === "claimed")
      expect(claimed?.jobId).toBe(admission.job.id)
      expect(harness.queue.findJob(admission.job.id)?.leaseGeneration).toBe(1)
    } finally {
      harness.cleanup()
    }
  }, 20_000)
})
