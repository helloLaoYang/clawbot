import { accessSync, constants, statfsSync } from "node:fs"
import { dirname } from "node:path"

import type { AppConfig } from "./config"

const ALLOWED_LOCAL_FILESYSTEMS = [0xef53, 0x5846_5342, 0x9123_683e] as const
const UNSAFE_FILESYSTEMS = [0x6969, 0xff53_4d42, 0x6573_5546] as const

export interface FilesystemProbe {
  assertWritable(path: string): void
  statfsType(path: string): number
  warn(message: string): void
}

export type DatabaseFilesystemFailure = "not_writable" | "unsafe" | "unsupported"

export class DatabaseFilesystemError extends Error {
  readonly name = "DatabaseFilesystemError"

  constructor(readonly reason: DatabaseFilesystemFailure) {
    super(`Database filesystem check failed: ${reason}`)
  }
}

const NODE_FILESYSTEM_PROBE: FilesystemProbe = {
  assertWritable(path) {
    accessSync(path, constants.W_OK)
  },
  statfsType(path) {
    return statfsSync(path).type
  },
  warn(message) {
    console.warn(message)
  },
}

function includesFilesystemType(types: readonly number[], filesystemType: number): boolean {
  return types.some((type) => type === filesystemType)
}

export function validateDatabaseFilesystem(
  config: AppConfig,
  probe: FilesystemProbe = NODE_FILESYSTEM_PROBE,
): void {
  const databaseParent = dirname(config.DATABASE_PATH)
  try {
    probe.assertWritable(databaseParent)
  } catch (error) {
    if (error instanceof Error) {
      throw new DatabaseFilesystemError("not_writable")
    }
    throw error
  }

  const filesystemType = probe.statfsType(databaseParent) >>> 0
  if (includesFilesystemType(UNSAFE_FILESYSTEMS, filesystemType)) {
    throw new DatabaseFilesystemError("unsafe")
  }
  if (includesFilesystemType(ALLOWED_LOCAL_FILESYSTEMS, filesystemType)) {
    return
  }
  if (config.NODE_ENV === "production") {
    throw new DatabaseFilesystemError("unsupported")
  }
  probe.warn("Database filesystem type is unrecognized; continuing outside production")
}
