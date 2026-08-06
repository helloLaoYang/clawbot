import { mkdirSync, rmSync } from "node:fs"

import { DatabaseInvariantError, EncryptionSentinelError, openDatabase } from "./database"
import {
  createAdmissionInput,
  createBotInput,
  createContextInput,
  createTestCipher,
  openTestDatabase,
} from "./test-support/fixtures"

const QA_ROOT = "/tmp/clawbot-qa"
const DATABASE_PATH = `${QA_ROOT}/task-4.sqlite`
const DATABASE_FILES = [DATABASE_PATH, `${DATABASE_PATH}-wal`, `${DATABASE_PATH}-shm`] as const

class SurfaceAssertionError extends Error {
  readonly name = "SurfaceAssertionError"
}

function assertSurface(condition: boolean, message: string): void {
  if (!condition) {
    throw new SurfaceAssertionError(message)
  }
}

function removeDatabaseFiles(): void {
  for (const path of DATABASE_FILES) {
    rmSync(path, { force: true })
  }
}

function expectCorruptSentinelFailure(): void {
  try {
    const unexpected = openTestDatabase(DATABASE_PATH)
    unexpected.close()
  } catch (error) {
    if (error instanceof EncryptionSentinelError) {
      return
    }
    throw error
  }
  throw new SurfaceAssertionError("corrupt sentinel was accepted")
}

function expectOldVersionFailure(): void {
  try {
    const unexpected = openDatabase({
      path: DATABASE_PATH,
      environment: "test",
      cipher: createTestCipher(),
      filesystemProbe: { statfsType: () => 0xef53 },
      sqliteVersionReader: { readVersion: () => "3.51.2" },
    })
    unexpected.close()
  } catch (error) {
    if (error instanceof DatabaseInvariantError && error.invariant === "sqlite_version") {
      return
    }
    throw error
  }
  throw new SurfaceAssertionError("old SQLite version was accepted")
}

function runSurface(): void {
  mkdirSync(QA_ROOT, { recursive: true })
  removeDatabaseFiles()

  const botInput = createBotInput()
  const contextInput = createContextInput(botInput.id, 1)
  const admissionInput = createAdmissionInput(botInput)
  const migrated = openTestDatabase(DATABASE_PATH)
  migrated.bots.create(botInput)
  migrated.contexts.upsert(contextInput)
  migrated.queue.admitSingle(admissionInput)
  migrated.close()

  const restarted = openTestDatabase(DATABASE_PATH)
  const bot = restarted.bots.findByPublicId(botInput.publicId)
  const credentials = restarted.bots.getCredentials(botInput.id)
  const context = restarted.contexts.find(botInput.id, contextInput.userLookupHash)
  const job = restarted.queue.findJob(admissionInput.job.id)

  assertSurface(bot?.ilinkUserId === botInput.ilinkUserId, "bound user did not decrypt")
  assertSurface(credentials?.botToken === botInput.botToken, "bot token did not decrypt")
  assertSurface(context?.contextToken === contextInput.contextToken, "context did not decrypt")
  assertSurface(job?.text === admissionInput.job.text, "queued text did not decrypt")
  assertSurface(job?.recipient === admissionInput.job.recipient, "recipient did not decrypt")
  const integrityCheck = restarted.client.pragma("integrity_check", { simple: true })
  const foreignKeyCheck = restarted.client.pragma("foreign_key_check")
  assertSurface(integrityCheck === "ok", "SQLite integrity check failed")
  assertSurface(
    Array.isArray(foreignKeyCheck) && foreignKeyCheck.length === 0,
    "foreign key check failed",
  )

  const surface = {
    migration: "ok",
    restart: "ok",
    integrity: "ok",
    typedRead: {
      publicId: bot?.publicId,
      accountFingerprint: bot?.accountFingerprint,
      authStatus: bot?.authStatus,
      contextFingerprint: context?.userFingerprint,
      jobStatus: job?.status,
      decryptedSecretsMatched: true,
    },
    pragmas: {
      journalMode: restarted.client.pragma("journal_mode", { simple: true }),
      synchronous: restarted.client.pragma("synchronous", { simple: true }),
      foreignKeys: restarted.client.pragma("foreign_keys", { simple: true }),
      busyTimeout: restarted.client.pragma("busy_timeout", { simple: true }),
      walAutocheckpoint: restarted.client.pragma("wal_autocheckpoint", { simple: true }),
    },
  } as const

  restarted.client
    .prepare<[string]>("UPDATE encryption_sentinel SET ciphertext = ? WHERE id = 1")
    .run("v1.corrupt.value.invalid")
  restarted.close()
  expectCorruptSentinelFailure()
  expectOldVersionFailure()

  process.stdout.write(
    `SURFACE: ${JSON.stringify({
      ...surface,
      corruptSentinel: "rejected",
      oldVersion: "rejected",
    })}\n`,
  )
}

try {
  runSurface()
} finally {
  removeDatabaseFiles()
}
