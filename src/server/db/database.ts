import Database from "better-sqlite3"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/better-sqlite3"

import type { FieldCipher } from "./contracts"
import { EpochMillisecondsSchema } from "./ids"
import {
  assertDatabaseFilesystem,
  assertSQLiteVersion,
  DatabaseInvariantError,
  type FileSystemProbe,
  type RuntimeEnvironment,
  type SQLiteVersionReader,
} from "./invariants"
import { migrateDatabase } from "./migrate"
import { DrizzleBotRepository } from "./repositories/bots"
import { DrizzleConversationRepository } from "./repositories/contexts"
import type {
  BotRepository,
  BotStateRepository,
  ConversationRepository,
  QueueRepository,
  RuntimeRepository,
} from "./repositories/contracts"
import { DrizzleQueueRepository } from "./repositories/queue"
import { DrizzleRuntimeRepository } from "./repositories/runtime"
import { DrizzleBotStateRepository } from "./repositories/state"
import * as schema from "./schema"
import { encryptionSentinel } from "./schema"
import type { ClawbotDatabase } from "./types"

const BUSY_TIMEOUT_MS = 5_000
const SENTINEL_PLAINTEXT = "clawbot:v1:encryption-sentinel"

type SQLiteVersionRow = { readonly version: string }

export type OpenDatabaseOptions = {
  readonly path: string
  readonly environment: RuntimeEnvironment
  readonly cipher: FieldCipher
  readonly filesystemProbe?: FileSystemProbe
  readonly sqliteVersionReader?: SQLiteVersionReader
  readonly onFilesystemWarning?: (message: string) => void
}

export type DatabaseHandle = {
  readonly client: Database.Database
  readonly orm: ClawbotDatabase
  readonly bots: BotRepository
  readonly contexts: ConversationRepository
  readonly state: BotStateRepository
  readonly queue: QueueRepository
  readonly runtime: RuntimeRepository
  readonly close: () => void
}

export class EncryptionSentinelError extends Error {
  readonly name = "EncryptionSentinelError"

  constructor(cause?: unknown) {
    if (cause === undefined) {
      super("database encryption sentinel verification failed")
    } else {
      super("database encryption sentinel verification failed", { cause })
    }
  }
}

export { DatabaseInvariantError }

export function openDatabase(options: OpenDatabaseOptions): DatabaseHandle {
  assertDatabaseFilesystem({
    databasePath: options.path,
    environment: options.environment,
    ...(options.filesystemProbe === undefined ? {} : { probe: options.filesystemProbe }),
    ...(options.onFilesystemWarning === undefined
      ? {}
      : { onWarning: options.onFilesystemWarning }),
  })

  const client = new Database(options.path, { timeout: BUSY_TIMEOUT_MS })
  try {
    const version = options.sqliteVersionReader?.readVersion() ?? readSQLiteVersion(client)
    assertSQLiteVersion(version)
    applyPragmas(client)
    migrateDatabase(client)
    const orm = drizzle(client, { schema })
    verifyEncryptionSentinel(orm, options.cipher)
    return {
      client,
      orm,
      bots: new DrizzleBotRepository(orm, options.cipher),
      contexts: new DrizzleConversationRepository(orm, options.cipher),
      state: new DrizzleBotStateRepository(orm, options.cipher),
      queue: new DrizzleQueueRepository(orm, options.cipher),
      runtime: new DrizzleRuntimeRepository(orm),
      close: () => client.close(),
    }
  } catch (error) {
    client.close()
    throw error
  }
}

function readSQLiteVersion(client: Database.Database): string {
  const row = client.prepare<[], SQLiteVersionRow>("SELECT sqlite_version() AS version").get()
  if (row === undefined) {
    throw new DatabaseInvariantError("sqlite_version", "SQLite version query returned no row")
  }
  return row.version
}

function applyPragmas(client: Database.Database): void {
  const journalMode = client.pragma("journal_mode = WAL", { simple: true })
  if (journalMode !== "wal") {
    throw new DatabaseInvariantError("pragma", "SQLite WAL mode could not be enabled")
  }
  client.pragma("synchronous = FULL")
  client.pragma("foreign_keys = ON")
  client.pragma("busy_timeout = 5000")
  client.pragma("wal_autocheckpoint = 1000")
}

function verifyEncryptionSentinel(database: ClawbotDatabase, cipher: FieldCipher): void {
  try {
    database.transaction(
      (transaction) => {
        const row = transaction
          .select()
          .from(encryptionSentinel)
          .where(eq(encryptionSentinel.id, 1))
          .get()
        if (row === undefined) {
          transaction
            .insert(encryptionSentinel)
            .values({
              id: 1,
              ciphertext: cipher.encrypt({
                table: "encryption_sentinel",
                rowId: "1",
                column: "ciphertext",
                plaintext: SENTINEL_PLAINTEXT,
              }),
              createdAt: EpochMillisecondsSchema.parse(Date.now()),
            })
            .run()
          return
        }
        const plaintext = cipher.decrypt({
          table: "encryption_sentinel",
          rowId: "1",
          column: "ciphertext",
          ciphertext: row.ciphertext,
        })
        if (plaintext !== SENTINEL_PLAINTEXT) {
          throw new EncryptionSentinelError()
        }
      },
      { behavior: "immediate" },
    )
  } catch (error) {
    if (error instanceof EncryptionSentinelError) {
      throw error
    }
    throw new EncryptionSentinelError(error)
  }
}
