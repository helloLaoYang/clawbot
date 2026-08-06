import { fileURLToPath } from "node:url"

import type Database from "better-sqlite3"
import { readMigrationFiles } from "drizzle-orm/migrator"

type MigrationRow = { readonly createdAt: number }

const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url))

export function migrateDatabase(client: Database.Database): void {
  const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER })
  const apply = client.transaction(() => {
    client.exec(`CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`)
    const latest = client
      .prepare<[], MigrationRow>(
        "SELECT created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1",
      )
      .get()
    for (const migration of migrations) {
      if (latest !== undefined && latest.createdAt >= migration.folderMillis) {
        continue
      }
      for (const statement of migration.sql) {
        client.exec(statement)
      }
      client
        .prepare<[string, number]>(
          "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
        )
        .run(migration.hash, migration.folderMillis)
    }
  })
  apply.immediate()
}
