import { type AppConfig, parseEnvironment } from "../config/config"
import { decryptField, encryptField } from "../crypto/envelope"
import { deriveCryptoKeys } from "../crypto/keys"
import type { FieldCipher } from "../db/contracts"
import { type DatabaseHandle, openDatabase } from "../db/database"
import { createQrHttpHandlers, type QrHttpHandlers } from "../qr/http"
import { createQrOnboardingService } from "../qr/service"
import { createTencentIlinkAdapter } from "../tencent/adapter"
import { type AdminAuthHandlers, createAdminAuthHandlers } from "./admin"

export type AuthenticationRuntime = Readonly<{
  admin: AdminAuthHandlers
  config: AppConfig
  database: DatabaseHandle
  qr: QrHttpHandlers
}>

let authenticationRuntime: AuthenticationRuntime | undefined

export function getAuthenticationRuntime(): AuthenticationRuntime {
  if (authenticationRuntime !== undefined) {
    return authenticationRuntime
  }

  const config = parseEnvironment(process.env)
  const keys = deriveCryptoKeys(config.APP_ENCRYPTION_KEY)
  const cipher: FieldCipher = {
    decrypt(input) {
      return decryptField(
        input.ciphertext,
        { column: input.column, rowUuid: input.rowId, table: input.table },
        keys,
      )
    },
    encrypt(input) {
      return encryptField(
        input.plaintext,
        { column: input.column, rowUuid: input.rowId, table: input.table },
        keys,
      )
    },
  }
  const database = openDatabase({
    cipher,
    environment: config.NODE_ENV,
    path: config.DATABASE_PATH,
  })
  const clock = { now: Date.now }
  const qrService = createQrOnboardingService({
    adapter: createTencentIlinkAdapter(),
    bots: database.bots,
    clock,
    keys,
    limits: {
      defaultBotMaxSendsPerMinute: config.DEFAULT_BOT_MAX_SENDS_PER_MINUTE,
      tencentMaxSendsPerMinute: config.TENCENT_MAX_SENDS_PER_MINUTE,
    },
    qrBots: database.qrBots,
  })
  authenticationRuntime = Object.freeze({
    admin: createAdminAuthHandlers({
      allowedOrigin: config.ADMIN_ALLOWED_ORIGIN,
      clock,
      passwordHash: config.ADMIN_PASSWORD_HASH,
      runtime: database.runtime,
      secureCookies: config.NODE_ENV === "production",
      sessionSecret: config.SESSION_SECRET,
    }),
    config,
    database,
    qr: createQrHttpHandlers({
      allowedOrigin: config.ADMIN_ALLOWED_ORIGIN,
      clock,
      service: qrService,
      sessionSecret: config.SESSION_SECRET,
    }),
  })
  return authenticationRuntime
}
