import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

import Database from "better-sqlite3"
import type { MigrationMeta } from "drizzle-orm/migrator"

import { DatabaseInvariantError } from "./invariants"
import migrationJournal from "./migrations/meta/_journal.json"

type MigrationRow = {
  readonly id: number
  readonly hash: string
  readonly createdAt: number
}

type MigrationColumnRow = {
  readonly id: number
  readonly name: string
  readonly type: string
  readonly required: number
  readonly defaultValue: string | null
  readonly primaryKey: number
}

type SchemaRow = {
  readonly type: string
  readonly name: string
  readonly tableName: string
  readonly sql: string
}

export type MigrationResult = {
  readonly initialized: boolean
}

const MIGRATION_SOURCES = [
  {
    sql: readFileSync(new URL("./migrations/0000_durable_model.sql", import.meta.url), "utf8"),
    tag: "0000_durable_model",
  },
] as const
const EXPECTED_MIGRATION_COLUMNS = [
  { id: 0, name: "id", type: "INTEGER", required: 0, defaultValue: null, primaryKey: 1 },
  { id: 1, name: "hash", type: "TEXT", required: 1, defaultValue: null, primaryKey: 0 },
  {
    id: 2,
    name: "created_at",
    type: "INTEGER",
    required: 1,
    defaultValue: null,
    primaryKey: 0,
  },
] as const

export function migrateDatabase(client: Database.Database): MigrationResult {
  try {
    const migrations = readBundledMigrations()
    const apply = client.transaction(() => {
      client.exec(`CREATE TABLE IF NOT EXISTS __drizzle_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`)
      const applied = readAppliedMigrations(client)
      assertMigrationJournal(applied, migrations)
      for (const migration of migrations.slice(applied.length)) {
        for (const statement of migration.sql) {
          client.exec(statement)
        }
        client
          .prepare<[string, number]>(
            "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
          )
          .run(migration.hash, migration.folderMillis)
      }
      assertApplicationSchema(client, migrations)
      return { initialized: applied.length === 0 && migrations.length > 0 }
    })
    return apply.immediate()
  } catch (error) {
    if (error instanceof DatabaseInvariantError) {
      throw error
    }
    throw new DatabaseInvariantError("migration", "database migration failed", { cause: error })
  }
}

function readBundledMigrations(): readonly MigrationMeta[] {
  if (migrationJournal.entries.length !== MIGRATION_SOURCES.length) {
    throw new DatabaseInvariantError("migration", "migration sources do not match journal")
  }
  return migrationJournal.entries.map((entry, index) => {
    const source = MIGRATION_SOURCES[index]
    if (source === undefined || entry.idx !== index || entry.tag !== source.tag) {
      throw new DatabaseInvariantError("migration", "migration sources do not match journal")
    }
    return {
      bps: entry.breakpoints,
      folderMillis: entry.when,
      hash: createHash("sha256").update(source.sql).digest("hex"),
      sql: source.sql.split("--> statement-breakpoint"),
    }
  })
}

function readAppliedMigrations(client: Database.Database): readonly MigrationRow[] {
  const columns = client
    .prepare<[], MigrationColumnRow>(`SELECT
      cid AS id,
      name,
      type,
      "notnull" AS required,
      dflt_value AS defaultValue,
      pk AS primaryKey
    FROM pragma_table_info('__drizzle_migrations')
    ORDER BY cid`)
    .all()
  if (JSON.stringify(columns) !== JSON.stringify(EXPECTED_MIGRATION_COLUMNS)) {
    throw new DatabaseInvariantError("migration", "migration journal schema does not match")
  }
  return client
    .prepare<[], MigrationRow>(
      "SELECT id, hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY id",
    )
    .all()
}

function assertMigrationJournal(
  applied: readonly MigrationRow[],
  migrations: readonly MigrationMeta[],
): void {
  for (const [index, row] of applied.entries()) {
    const migration = migrations[index]
    if (
      migration === undefined ||
      row.id !== index + 1 ||
      row.hash !== migration.hash ||
      row.createdAt !== migration.folderMillis
    ) {
      throw new DatabaseInvariantError("migration", "migration journal does not match files")
    }
  }
}

function assertApplicationSchema(
  client: Database.Database,
  migrations: readonly MigrationMeta[],
): void {
  const reference = new Database(":memory:")
  try {
    for (const migration of migrations) {
      for (const statement of migration.sql) {
        reference.exec(statement)
      }
    }
    const expected = readApplicationSchema(reference)
    const actual = readApplicationSchema(client)
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new DatabaseInvariantError("migration", "database schema does not match migrations")
    }
  } finally {
    reference.close()
  }
}

function readApplicationSchema(client: Database.Database): readonly SchemaRow[] {
  return client
    .prepare<[], SchemaRow>(`SELECT
      type,
      name,
      tbl_name AS tableName,
      sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
      AND name <> '__drizzle_migrations'
      AND sql IS NOT NULL
    ORDER BY type, name`)
    .all()
}
