import { Buffer } from "node:buffer"
import { isAbsolute } from "node:path"
import { z } from "zod"

const REDACTED = "[redacted]" as const
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const ADMIN_PASSWORD_HASH_PATTERN =
  /^scrypt\$v1\$32768\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/
const TENCENT_ORIGIN_OVERRIDE_PATTERN = /^TENCENT_.*(?:ORIGIN|URL)$/

function isCanonicalBase64(value: string, minimumBytes: number, exactBytes?: number): boolean {
  if (!BASE64_PATTERN.test(value)) {
    return false
  }

  const decoded = Buffer.from(value, "base64")
  const hasRequiredLength =
    exactBytes === undefined ? decoded.length >= minimumBytes : decoded.length === exactBytes
  return hasRequiredLength && decoded.toString("base64") === value
}

function isCanonicalBase64Url(value: string, bytes: number): boolean {
  if (!BASE64URL_PATTERN.test(value)) {
    return false
  }

  const decoded = Buffer.from(value, "base64url")
  return decoded.length === bytes && decoded.toString("base64url") === value
}

function isAdminPasswordHash(value: string): boolean {
  const match = ADMIN_PASSWORD_HASH_PATTERN.exec(value)
  const salt = match?.at(1)
  const digest = match?.at(2)
  return (
    salt !== undefined &&
    digest !== undefined &&
    isCanonicalBase64Url(salt, 16) &&
    isCanonicalBase64Url(digest, 32)
  )
}

function isCanonicalOrigin(value: string): boolean {
  try {
    const parsed = new URL(value)
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.origin === value
    )
  } catch (error) {
    if (error instanceof TypeError) {
      return false
    }
    throw error
  }
}

const IntegerEnvironmentSchema = (minimum: number, maximum: number) =>
  z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .transform(Number)
    .pipe(z.number().int().min(minimum).max(maximum))

export const AppEncryptionKeySchema = z
  .string()
  .refine((value) => isCanonicalBase64(value, 32, 32))
  .brand("AppEncryptionKey")

export const SessionSecretSchema = z
  .string()
  .refine((value) => isCanonicalBase64(value, 32))
  .brand("SessionSecret")

export const AdminPasswordHashSchema = z
  .string()
  .refine(isAdminPasswordHash)
  .brand("AdminPasswordHash")

export const BearerHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .brand("BearerHash")

const EnvironmentSchema = z
  .object({
    ADMIN_ALLOWED_ORIGIN: z.string().refine(isCanonicalOrigin).brand("AdminAllowedOrigin"),
    ADMIN_API_BEARER_HASH: BearerHashSchema,
    ADMIN_BATCH_MAX_BOTS: IntegerEnvironmentSchema(1, 100).default(20),
    ADMIN_PASSWORD_HASH: AdminPasswordHashSchema,
    APP_ENCRYPTION_KEY: AppEncryptionKeySchema,
    DATABASE_PATH: z.string().min(1).brand("DatabasePath"),
    DEFAULT_BOT_MAX_SENDS_PER_MINUTE: IntegerEnvironmentSchema(1, 600).default(1),
    NEXT_MANUAL_SIG_HANDLE: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    NODE_ENV: z.enum(["development", "test", "production"]),
    PORT: IntegerEnvironmentSchema(1, 65_535).default(3_000),
    SESSION_SECRET: SessionSecretSchema,
    TENCENT_MAX_SENDS_PER_MINUTE: IntegerEnvironmentSchema(1, 600),
  })
  .superRefine((config, context) => {
    if (config.DEFAULT_BOT_MAX_SENDS_PER_MINUTE > config.TENCENT_MAX_SENDS_PER_MINUTE) {
      context.addIssue({
        code: "custom",
        message: "must not exceed TENCENT_MAX_SENDS_PER_MINUTE",
        path: ["DEFAULT_BOT_MAX_SENDS_PER_MINUTE"],
      })
    }

    if (config.NODE_ENV === "production") {
      if (!isAbsolute(config.DATABASE_PATH)) {
        context.addIssue({
          code: "custom",
          message: "must be absolute in production",
          path: ["DATABASE_PATH"],
        })
      }
      if (!config.ADMIN_ALLOWED_ORIGIN.startsWith("https://")) {
        context.addIssue({
          code: "custom",
          message: "must use HTTPS in production",
          path: ["ADMIN_ALLOWED_ORIGIN"],
        })
      }
      if (!config.NEXT_MANUAL_SIG_HANDLE) {
        context.addIssue({
          code: "custom",
          message: "must be true in production",
          path: ["NEXT_MANUAL_SIG_HANDLE"],
        })
      }
    }
  })
  .readonly()

export type AppEncryptionKey = z.infer<typeof AppEncryptionKeySchema>
export type SessionSecret = z.infer<typeof SessionSecretSchema>
export type AdminPasswordHash = z.infer<typeof AdminPasswordHashSchema>
export type BearerHash = z.infer<typeof BearerHashSchema>
export type AppConfig = z.infer<typeof EnvironmentSchema>

export type RedactedConfig = Readonly<
  Omit<
    AppConfig,
    "ADMIN_API_BEARER_HASH" | "ADMIN_PASSWORD_HASH" | "APP_ENCRYPTION_KEY" | "SESSION_SECRET"
  > & {
    readonly ADMIN_API_BEARER_HASH: typeof REDACTED
    readonly ADMIN_PASSWORD_HASH: typeof REDACTED
    readonly APP_ENCRYPTION_KEY: typeof REDACTED
    readonly SESSION_SECRET: typeof REDACTED
  }
>

export class ConfigError extends Error {
  readonly name = "ConfigError"
  readonly variables: readonly string[]

  constructor(variables: readonly string[]) {
    const uniqueVariables = [...new Set(variables)].sort()
    super(`Invalid environment configuration: ${uniqueVariables.join(", ")}`)
    this.variables = Object.freeze(uniqueVariables)
  }

  toJSON(): Readonly<{ name: string; message: string; variables: readonly string[] }> {
    return { message: this.message, name: this.name, variables: this.variables }
  }
}

export function parseEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): AppConfig {
  const { NODE_ENV: nodeEnvironment } = environment
  const tencentOverrides = Object.keys(environment).filter((name) =>
    TENCENT_ORIGIN_OVERRIDE_PATTERN.test(name),
  )
  if (nodeEnvironment !== "test" && tencentOverrides.length > 0) {
    throw new ConfigError(tencentOverrides)
  }

  const result = EnvironmentSchema.safeParse(environment)
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => String(issue.path.at(0) ?? "environment")),
    )
  }
  return result.data
}

export function redactConfig(config: AppConfig): RedactedConfig {
  return Object.freeze({
    ADMIN_ALLOWED_ORIGIN: config.ADMIN_ALLOWED_ORIGIN,
    ADMIN_API_BEARER_HASH: REDACTED,
    ADMIN_BATCH_MAX_BOTS: config.ADMIN_BATCH_MAX_BOTS,
    ADMIN_PASSWORD_HASH: REDACTED,
    APP_ENCRYPTION_KEY: REDACTED,
    DATABASE_PATH: config.DATABASE_PATH,
    DEFAULT_BOT_MAX_SENDS_PER_MINUTE: config.DEFAULT_BOT_MAX_SENDS_PER_MINUTE,
    NEXT_MANUAL_SIG_HANDLE: config.NEXT_MANUAL_SIG_HANDLE,
    NODE_ENV: config.NODE_ENV,
    PORT: config.PORT,
    SESSION_SECRET: REDACTED,
    TENCENT_MAX_SENDS_PER_MINUTE: config.TENCENT_MAX_SENDS_PER_MINUTE,
  })
}

export {
  DatabaseFilesystemError,
  type FilesystemProbe,
  validateDatabaseFilesystem,
} from "./filesystem"
