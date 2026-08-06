import { Buffer } from "node:buffer"
import { describe, expect, it, vi } from "vitest"

import {
  ConfigError,
  DatabaseFilesystemError,
  type FilesystemProbe,
  parseEnvironment,
  redactConfig,
  validateDatabaseFilesystem,
} from "./config"

const VALID_ENV = {
  ADMIN_ALLOWED_ORIGIN: "http://localhost:3000",
  ADMIN_API_BEARER_HASH: "ab".repeat(32),
  ADMIN_PASSWORD_HASH:
    "scrypt$v1$32768$8$1$AAECAwQFBgcICQoLDA0ODw$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString("base64"),
  DATABASE_PATH: "/tmp/clawbot-qa/clawbot.sqlite",
  NODE_ENV: "test",
  SESSION_SECRET: Buffer.alloc(32, 29).toString("base64"),
  TENCENT_MAX_SENDS_PER_MINUTE: "60",
} as const

const INVALID_ENVIRONMENTS = [
  ["requires NODE_ENV", { NODE_ENV: undefined }],
  ["requires DATABASE_PATH", { DATABASE_PATH: undefined }],
  ["requires APP_ENCRYPTION_KEY", { APP_ENCRYPTION_KEY: undefined }],
  ["requires SESSION_SECRET", { SESSION_SECRET: undefined }],
  ["requires ADMIN_PASSWORD_HASH", { ADMIN_PASSWORD_HASH: undefined }],
  ["requires ADMIN_API_BEARER_HASH", { ADMIN_API_BEARER_HASH: undefined }],
  ["requires ADMIN_ALLOWED_ORIGIN", { ADMIN_ALLOWED_ORIGIN: undefined }],
  ["requires TENCENT_MAX_SENDS_PER_MINUTE", { TENCENT_MAX_SENDS_PER_MINUTE: undefined }],
  ["rejects an unknown NODE_ENV", { NODE_ENV: "staging" }],
  ["rejects an empty database path", { DATABASE_PATH: "" }],
  [
    "requires a 32-byte APP_ENCRYPTION_KEY",
    { APP_ENCRYPTION_KEY: Buffer.alloc(31).toString("base64") },
  ],
  ["requires a 32-byte SESSION_SECRET", { SESSION_SECRET: Buffer.alloc(31).toString("base64") }],
  ["rejects a noncanonical administrator hash", { ADMIN_API_BEARER_HASH: "AB".repeat(32) }],
  ["rejects a malformed password hash", { ADMIN_PASSWORD_HASH: "scrypt$v1$1$8$1$salt$hash" }],
  ["rejects an origin path", { ADMIN_ALLOWED_ORIGIN: "http://localhost:3000/admin" }],
  ["rejects a zero Tencent ceiling", { TENCENT_MAX_SENDS_PER_MINUTE: "0" }],
  ["rejects a ceiling above 600", { TENCENT_MAX_SENDS_PER_MINUTE: "601" }],
  [
    "rejects a default bot rate above the Tencent ceiling",
    { DEFAULT_BOT_MAX_SENDS_PER_MINUTE: "61" },
  ],
  ["rejects a batch limit above 100", { ADMIN_BATCH_MAX_BOTS: "101" }],
  ["rejects an invalid signal flag", { NEXT_MANUAL_SIG_HANDLE: "yes" }],
  ["rejects a port above 65535", { PORT: "65536" }],
] as const

describe("parseEnvironment", () => {
  it("parses the exact environment contract with defaults", () => {
    // Given: the required environment values.
    // When: configuration is parsed at the process boundary.
    const config = parseEnvironment(VALID_ENV)

    // Then: typed defaults are applied without changing required values.
    expect(config).toMatchObject({
      ADMIN_BATCH_MAX_BOTS: 20,
      DEFAULT_BOT_MAX_SENDS_PER_MINUTE: 1,
      NEXT_MANUAL_SIG_HANDLE: false,
      NODE_ENV: "test",
      PORT: 3000,
      TENCENT_MAX_SENDS_PER_MINUTE: 60,
    })
  })

  it.each(INVALID_ENVIRONMENTS)("%s", (_name, overrides) => {
    // Given: one invalid environment value.
    const environment = { ...VALID_ENV, ...overrides }

    // When: configuration is parsed.
    const parse = () => parseEnvironment(environment)

    // Then: startup fails with a typed, redacted configuration error.
    expect(parse).toThrow(ConfigError)
  })

  it("enforces production-only path, HTTPS, signal, and Tencent override rules", () => {
    // Given: production configuration that violates every production-only boundary.
    const environment = {
      ...VALID_ENV,
      ADMIN_ALLOWED_ORIGIN: "http://localhost:3000",
      DATABASE_PATH: "relative.sqlite",
      NEXT_MANUAL_SIG_HANDLE: "false",
      NODE_ENV: "production",
      TENCENT_API_ORIGIN: "https://example.test",
    }

    // When: configuration is parsed.
    const parse = () => parseEnvironment(environment)

    // Then: startup fails closed.
    expect(parse).toThrow(ConfigError)
  })

  it("permits Tencent origin overrides only in test environments", () => {
    // Given: a test-only Tencent origin override.
    const environment = { ...VALID_ENV, TENCENT_API_ORIGIN: "https://example.test" }

    // When: test configuration is parsed.
    const config = parseEnvironment(environment)

    // Then: the normal typed configuration remains valid.
    expect(config.NODE_ENV).toBe("test")
  })

  it("serializes failures without secret values", () => {
    // Given: distinct secret values that fail validation.
    const environment = {
      ...VALID_ENV,
      APP_ENCRYPTION_KEY: "APP_SECRET_MUST_NOT_APPEAR",
      SESSION_SECRET: "SESSION_SECRET_MUST_NOT_APPEAR",
    }

    // When: the typed configuration error is serialized.
    let serialized = ""
    try {
      parseEnvironment(environment)
    } catch (error) {
      if (!(error instanceof ConfigError)) {
        throw error
      }
      serialized = JSON.stringify(error)
    }

    // Then: neither rejected secret is present.
    expect(serialized).not.toContain(environment.APP_ENCRYPTION_KEY)
    expect(serialized).not.toContain(environment.SESSION_SECRET)
  })

  it("returns an explicitly redacted configuration shape", () => {
    // Given: valid configuration containing every secret class.
    const config = parseEnvironment(VALID_ENV)

    // When: it is prepared for diagnostic output.
    const serialized = JSON.stringify(redactConfig(config))

    // Then: secret keys remain identifiable but their values are absent.
    expect(serialized).toContain('"APP_ENCRYPTION_KEY":"[redacted]"')
    expect(serialized).toContain('"SESSION_SECRET":"[redacted]"')
    expect(serialized).not.toContain(VALID_ENV.APP_ENCRYPTION_KEY)
    expect(serialized).not.toContain(VALID_ENV.SESSION_SECRET)
    expect(serialized).not.toContain(VALID_ENV.ADMIN_PASSWORD_HASH)
    expect(serialized).not.toContain(VALID_ENV.ADMIN_API_BEARER_HASH)
  })
})

describe("validateDatabaseFilesystem", () => {
  it("accepts an allowlisted production filesystem", () => {
    // Given: valid production configuration on Linux ext-family storage.
    const config = parseEnvironment({
      ...VALID_ENV,
      ADMIN_ALLOWED_ORIGIN: "https://clawbot.example",
      NEXT_MANUAL_SIG_HANDLE: "true",
      NODE_ENV: "production",
    })
    const probe = {
      assertWritable: vi.fn(),
      statfsType: vi.fn(() => 0xef53),
      warn: vi.fn(),
    } satisfies FilesystemProbe

    // When: the database parent is checked.
    validateDatabaseFilesystem(config, probe)

    // Then: it is accepted without warnings.
    expect(probe.warn).not.toHaveBeenCalled()
  })

  it.each([0x6969, 0xff53_4d42, 0x6573_5546])(
    "rejects unsafe filesystem type %s in every environment",
    (filesystemType) => {
      // Given: valid test configuration on known unsafe storage.
      const config = parseEnvironment(VALID_ENV)
      const probe = {
        assertWritable: vi.fn(),
        statfsType: vi.fn(() => filesystemType),
        warn: vi.fn(),
      } satisfies FilesystemProbe

      // When: the database parent is checked.
      const validate = () => validateDatabaseFilesystem(config, probe)

      // Then: startup rejects the storage.
      expect(validate).toThrow(DatabaseFilesystemError)
    },
  )

  it("rejects an unknown production filesystem", () => {
    // Given: production configuration on a filesystem outside the allowlist.
    const config = parseEnvironment({
      ...VALID_ENV,
      ADMIN_ALLOWED_ORIGIN: "https://clawbot.example",
      NEXT_MANUAL_SIG_HANDLE: "true",
      NODE_ENV: "production",
    })
    const probe = {
      assertWritable: vi.fn(),
      statfsType: vi.fn(() => 0x1234),
      warn: vi.fn(),
    } satisfies FilesystemProbe

    // When: the database parent is checked.
    const validate = () => validateDatabaseFilesystem(config, probe)

    // Then: production startup fails closed.
    expect(validate).toThrow(DatabaseFilesystemError)
  })

  it("warns and continues for unknown development and test filesystems", () => {
    // Given: test configuration on an unclassified local filesystem.
    const config = parseEnvironment(VALID_ENV)
    const probe = {
      assertWritable: vi.fn(),
      statfsType: vi.fn(() => 0x1234),
      warn: vi.fn(),
    } satisfies FilesystemProbe

    // When: the database parent is checked.
    validateDatabaseFilesystem(config, probe)

    // Then: startup continues with one sanitized warning.
    expect(probe.warn).toHaveBeenCalledOnce()
  })
})
