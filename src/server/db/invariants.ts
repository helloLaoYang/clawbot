import { statfsSync } from "node:fs"
import { dirname, isAbsolute } from "node:path"

const MINIMUM_SQLITE_VERSION = { major: 3, minor: 51, patch: 3 } as const
const PRODUCTION_FILESYSTEMS = new Set([0xef53n, 0x5846_5342n, 0x9123_683en])
const NETWORK_FILESYSTEMS = new Set([0x6969n, 0xff53_4d42n, 0x6573_5546n])

export type RuntimeEnvironment = "development" | "test" | "production"

export interface FileSystemProbe {
  statfsType(directory: string): number | bigint
}

export interface SQLiteVersionReader {
  readVersion(): string
}

export class DatabaseInvariantError extends Error {
  readonly name = "DatabaseInvariantError"

  constructor(
    readonly invariant: "filesystem" | "sqlite_version" | "pragma",
    message: string,
  ) {
    super(message)
  }
}

type FilesystemOptions = {
  readonly databasePath: string
  readonly environment: RuntimeEnvironment
  readonly probe?: FileSystemProbe
  readonly onWarning?: (message: string) => void
}

const SYSTEM_FILESYSTEM_PROBE: FileSystemProbe = {
  statfsType: (directory) => statfsSync(directory).type,
}

export function assertDatabaseFilesystem(options: FilesystemOptions): void {
  if (options.environment === "production" && !isAbsolute(options.databasePath)) {
    throw new DatabaseInvariantError("filesystem", "production database path must be absolute")
  }

  const type = BigInt(
    (options.probe ?? SYSTEM_FILESYSTEM_PROBE).statfsType(dirname(options.databasePath)),
  )
  if (NETWORK_FILESYSTEMS.has(type)) {
    throw new DatabaseInvariantError("filesystem", "database filesystem is not local")
  }
  if (options.environment === "production" && !PRODUCTION_FILESYSTEMS.has(type)) {
    throw new DatabaseInvariantError(
      "filesystem",
      "database filesystem is not approved for production",
    )
  }
  if (options.environment !== "production" && !PRODUCTION_FILESYSTEMS.has(type)) {
    const message = "database filesystem is not on the production allowlist"
    if (options.onWarning === undefined) {
      process.emitWarning(message)
    } else {
      options.onWarning(message)
    }
  }
}

export function assertSQLiteVersion(version: string): void {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  const majorText = match?.[1]
  const minorText = match?.[2]
  const patchText = match?.[3]
  if (majorText === undefined || minorText === undefined || patchText === undefined) {
    throw new DatabaseInvariantError("sqlite_version", "SQLite returned an invalid version")
  }

  const major = Number(majorText)
  const minor = Number(minorText)
  const patch = Number(patchText)
  const supported =
    major > MINIMUM_SQLITE_VERSION.major ||
    (major === MINIMUM_SQLITE_VERSION.major && minor > MINIMUM_SQLITE_VERSION.minor) ||
    (major === MINIMUM_SQLITE_VERSION.major &&
      minor === MINIMUM_SQLITE_VERSION.minor &&
      patch >= MINIMUM_SQLITE_VERSION.patch)
  if (!supported) {
    throw new DatabaseInvariantError("sqlite_version", "SQLite 3.51.3 or newer is required")
  }
}
