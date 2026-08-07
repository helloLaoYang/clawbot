import { Buffer } from "node:buffer"

import { AppEncryptionKeySchema, SessionSecretSchema } from "../config/config"
import { type AdminSessionId, createAdminSession } from "../crypto/admin-auth"
import { deriveCryptoKeys } from "../crypto/keys"
import type { DatabaseHandle } from "../db/database"
import type { BotPublicId } from "../db/ids"
import {
  createTestDatabase,
  openTestDatabase,
  type TestDatabase,
} from "../db/test-support/fixtures"
import type {
  FetchQrCodeInput,
  GetQrStatusInput,
  QrCodeResponse,
  QrStatusResponse,
} from "../tencent/protocol"
import { createQrOnboardingService, type QrOnboardingService } from "./service"

export const QR_TEST_NOW = 1_820_000_000_000
export const QR_TEST_ORIGIN = "http://localhost:3000"
export const QR_TEST_APP_KEY = AppEncryptionKeySchema.parse(Buffer.alloc(32, 83).toString("base64"))
export const QR_TEST_SESSION_SECRET = SessionSecretSchema.parse(
  Buffer.alloc(32, 97).toString("base64"),
)

export const confirmedStatus = {
  status: "confirmed",
  bot_token: "confirmed-bot-token",
  ilink_bot_id: "confirmed-bot@im.bot",
  ilink_user_id: "confirmed-user@im.wechat",
  baseurl: "https://ilinkai.weixin.qq.com",
} as const satisfies QrStatusResponse

class QrFixtureError extends Error {
  readonly name = "QrFixtureError"
}

type DeferredStatus = Readonly<{
  promise: Promise<QrStatusResponse>
  resolve: (status: QrStatusResponse) => void
}>

export class StubQrAdapter {
  readonly fetchInputs: FetchQrCodeInput[] = []
  readonly pollInputs: GetQrStatusInput[] = []
  private fetchSequence = 0
  private readonly statuses: Array<QrStatusResponse | Promise<QrStatusResponse>>

  constructor(statuses: readonly (QrStatusResponse | Promise<QrStatusResponse>)[]) {
    this.statuses = [...statuses]
  }

  async fetchQrCode(input: FetchQrCodeInput): Promise<QrCodeResponse> {
    this.fetchInputs.push(input)
    this.fetchSequence += 1
    const suffix = this.fetchSequence === 1 ? "" : `-${this.fetchSequence}`
    return {
      qrcode: `qr-secret${suffix}`,
      qrcode_img_content: `https://weixin.qq.com/x/qr${suffix}`,
    }
  }

  async getQrStatus(input: GetQrStatusInput): Promise<QrStatusResponse> {
    this.pollInputs.push(input)
    const status = this.statuses.shift()
    if (status === undefined) {
      throw new QrFixtureError("QR status fixture was exhausted")
    }
    return status
  }

  enqueue(status: QrStatusResponse): void {
    this.statuses.push(status)
  }
}

export type QrHarness = Readonly<{
  adapter: StubQrAdapter
  database: DatabaseHandle
  ownerId: AdminSessionId
  ownerToken: string
  otherOwnerId: AdminSessionId
  service: QrOnboardingService
  setNow: (value: number) => void
  restart: () => QrOnboardingService
  cleanup: () => void
}>

export function deferredQrStatus(): DeferredStatus {
  let resolveStatus: ((status: QrStatusResponse) => void) | undefined
  const promise = new Promise<QrStatusResponse>((resolve) => {
    resolveStatus = resolve
  })
  return {
    promise,
    resolve: (status) => {
      if (resolveStatus === undefined) {
        throw new QrFixtureError("deferred QR status was not initialized")
      }
      resolveStatus(status)
    },
  }
}

export function createQrHarness(
  label: string,
  statuses: readonly (QrStatusResponse | Promise<QrStatusResponse>)[],
): QrHarness {
  const testDatabase: TestDatabase = createTestDatabase(label)
  const database = openTestDatabase(testDatabase.path)
  const adapter = new StubQrAdapter(statuses)
  const ownerSession = createAdminSession(QR_TEST_SESSION_SECRET, QR_TEST_NOW)
  let now = QR_TEST_NOW
  const createService = () =>
    createQrOnboardingService({
      adapter,
      bots: database.bots,
      clock: { now: () => now },
      keys: deriveCryptoKeys(QR_TEST_APP_KEY),
      limits: { defaultBotMaxSendsPerMinute: 7, tencentMaxSendsPerMinute: 60 },
      qrBots: database.qrBots,
    })
  return {
    adapter,
    cleanup: () => {
      database.close()
      testDatabase.cleanup()
    },
    database,
    otherOwnerId: createAdminSession(QR_TEST_SESSION_SECRET, QR_TEST_NOW + 1).id,
    ownerId: ownerSession.id,
    ownerToken: ownerSession.token,
    restart: createService,
    service: createService(),
    setNow: (value) => {
      now = value
    },
  }
}

export async function startQrSession(
  harness: Pick<QrHarness, "ownerId" | "service">,
  botPublicId?: BotPublicId,
) {
  const result = await harness.service.start({
    ownerId: harness.ownerId,
    ...(botPublicId === undefined ? {} : { botPublicId }),
  })
  if (result.kind !== "ok") {
    throw new QrFixtureError(`expected QR start success, received ${result.kind}`)
  }
  return result.value
}
