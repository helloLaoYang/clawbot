// @vitest-environment node

import { describe, expect, it } from "vitest"

import { DatabaseInvariantError, EncryptionSentinelError, openDatabase } from "./database"
import { assertDatabaseFilesystem } from "./invariants"
import { createTestCipher, createTestDatabase, openTestDatabase } from "./test-support/fixtures"

type TableNameRow = { readonly name: string }

const EXPECTED_TABLES = [
  "__drizzle_migrations",
  "admin_login_state",
  "attempts",
  "batches",
  "bot_secrets",
  "bots",
  "conversation_contexts",
  "encryption_sentinel",
  "inbound_state",
  "invocations",
  "jobs",
  "rate_state",
  "service_lease",
] as const

describe("database startup", () => {
  it("migrates a clean database and applies the exact connection pragmas", () => {
    // Given: an empty local SQLite path.
    const testDatabase = createTestDatabase("task-4-startup")

    try {
      // When: the application opens the database.
      const handle = openTestDatabase(testDatabase.path)
      const tables = handle.client
        .prepare<[], TableNameRow>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map(({ name }) => name)

      // Then: every durable table exists and safety pragmas are exact.
      expect(tables).toEqual(EXPECTED_TABLES)
      expect(handle.client.pragma("journal_mode", { simple: true })).toBe("wal")
      expect(handle.client.pragma("synchronous", { simple: true })).toBe(2)
      expect(handle.client.pragma("foreign_keys", { simple: true })).toBe(1)
      expect(handle.client.pragma("busy_timeout", { simple: true })).toBe(5_000)
      expect(handle.client.pragma("wal_autocheckpoint", { simple: true })).toBe(1_000)
      handle.close()
    } finally {
      testDatabase.cleanup()
    }
  })

  it("rejects a SQLite runtime older than 3.51.3", () => {
    // Given: a clean database and an old-version adapter.
    const testDatabase = createTestDatabase("task-4-old-version")

    try {
      // When/Then: readiness fails before migrations are accepted.
      expect(() =>
        openDatabase({
          path: testDatabase.path,
          environment: "test",
          cipher: createTestCipher(),
          filesystemProbe: { statfsType: () => 0xef53 },
          sqliteVersionReader: { readVersion: () => "3.51.2" },
        }),
      ).toThrowError(DatabaseInvariantError)
    } finally {
      testDatabase.cleanup()
    }
  })

  it("enforces the production allowlist and rejects known network filesystems everywhere", () => {
    // Given: production, test, local, and network filesystem probes.
    const warnings: string[] = []

    // When/Then: production accepts only allowlisted local filesystems.
    expect(() =>
      assertDatabaseFilesystem({
        databasePath: "/tmp/clawbot-qa/production.sqlite",
        environment: "production",
        probe: { statfsType: () => 0xef53 },
        onWarning: (message) => warnings.push(message),
      }),
    ).not.toThrow()
    expect(() =>
      assertDatabaseFilesystem({
        databasePath: "/tmp/clawbot-qa/overlay.sqlite",
        environment: "production",
        probe: { statfsType: () => 0x794c_7630 },
        onWarning: (message) => warnings.push(message),
      }),
    ).toThrowError(DatabaseInvariantError)
    expect(() =>
      assertDatabaseFilesystem({
        databasePath: "/tmp/clawbot-qa/nfs.sqlite",
        environment: "test",
        probe: { statfsType: () => 0x6969 },
        onWarning: (message) => warnings.push(message),
      }),
    ).toThrowError(DatabaseInvariantError)
    expect(() =>
      assertDatabaseFilesystem({
        databasePath: "/tmp/clawbot-qa/unknown.sqlite",
        environment: "test",
        probe: { statfsType: () => 0x1234 },
        onWarning: (message) => warnings.push(message),
      }),
    ).not.toThrow()
    expect(warnings).toHaveLength(1)
  })

  it("survives restart with one key and rejects a different sentinel key", () => {
    // Given: a migrated database initialized with one field cipher.
    const testDatabase = createTestDatabase("task-4-sentinel-key")
    const first = openTestDatabase(testDatabase.path, createTestCipher("first-key"))
    first.close()

    try {
      // When: the database restarts with the original and then a different key.
      const restarted = openTestDatabase(testDatabase.path, createTestCipher("first-key"))
      restarted.close()

      // Then: only the mismatched key fails readiness.
      expect(() =>
        openTestDatabase(testDatabase.path, createTestCipher("different-key")),
      ).toThrowError(EncryptionSentinelError)
    } finally {
      testDatabase.cleanup()
    }
  })

  it("rejects a corrupt encryption sentinel", () => {
    // Given: a migrated database whose sentinel was corrupted on disk.
    const testDatabase = createTestDatabase("task-4-sentinel-corrupt")
    const handle = openTestDatabase(testDatabase.path)
    handle.client
      .prepare<[string]>("UPDATE encryption_sentinel SET ciphertext = ? WHERE id = 1")
      .run("v1.corrupt.value.invalid")
    handle.close()

    try {
      // When/Then: restart fails closed.
      expect(() => openTestDatabase(testDatabase.path)).toThrowError(EncryptionSentinelError)
    } finally {
      testDatabase.cleanup()
    }
  })
})
