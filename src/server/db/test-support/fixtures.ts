import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"

import type {
  AdmissionInput,
  CreateBotInput,
  DecryptFieldInput,
  EncryptFieldInput,
  FieldCipher,
  RecordAttemptInput,
  UpsertContextInput,
} from "../contracts"
import { type DatabaseHandle, openDatabase } from "../database"
import {
  AttemptIdSchema,
  BotIdSchema,
  BotPublicIdSchema,
  ContextIdSchema,
  EpochMillisecondsSchema,
  InvocationIdSchema,
  JobIdSchema,
} from "../ids"

const QA_ROOT = "/tmp/clawbot-qa"
const LOCAL_FILESYSTEM_TYPE = 0xef53
const TEST_CIPHER_KEY = "task-4-test-key"

class TestCipherError extends Error {
  readonly name = "TestCipherError"
}

class TestFixtureError extends Error {
  readonly name = "TestFixtureError"
}

export type TestDatabase = {
  readonly path: string
  readonly cleanup: () => void
}

export function createTestDatabase(label: string): TestDatabase {
  mkdirSync(QA_ROOT, { recursive: true })
  const directory = mkdtempSync(join(QA_ROOT, `${label}-`))
  return {
    path: join(directory, "clawbot.sqlite"),
    cleanup: () => rmSync(directory, { force: true, recursive: true }),
  }
}

export function createTestCipher(key = TEST_CIPHER_KEY): FieldCipher {
  return {
    encrypt(input: EncryptFieldInput): string {
      const plaintext = Buffer.from(input.plaintext, "utf8").toString("base64url")
      const aad = Buffer.from(`${input.table}|${input.rowId}|${input.column}`, "utf8").toString(
        "base64url",
      )
      return `v1.${key}.${plaintext}.${aad}`
    },
    decrypt(input: DecryptFieldInput): string {
      const [version, storedKey, plaintext, aad, unexpected] = input.ciphertext.split(".")
      const expectedAad = Buffer.from(
        `${input.table}|${input.rowId}|${input.column}`,
        "utf8",
      ).toString("base64url")
      if (
        version !== "v1" ||
        storedKey !== key ||
        plaintext === undefined ||
        aad !== expectedAad ||
        unexpected !== undefined
      ) {
        throw new TestCipherError()
      }
      return Buffer.from(plaintext, "base64url").toString("utf8")
    },
  }
}

export function openTestDatabase(path: string, cipher = createTestCipher()): DatabaseHandle {
  return openDatabase({
    path,
    environment: "test",
    cipher,
    filesystemProbe: { statfsType: () => LOCAL_FILESYSTEM_TYPE },
  })
}

export function createBotInput(nowValue = 1_800_000_000_000): CreateBotInput {
  const now = EpochMillisecondsSchema.parse(nowValue)
  const ilinkBotIdLookupHash = randomUUID().replaceAll("-", "").repeat(2)
  return {
    id: BotIdSchema.parse(randomUUID()),
    publicId: BotPublicIdSchema.parse(randomUUID()),
    accountFingerprint: `acct_${ilinkBotIdLookupHash.slice(0, 8)}`,
    ilinkBotIdLookupHash,
    boundUserFingerprint: `user_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
    ilinkBotId: `ilink-bot-${randomUUID()}`,
    ilinkUserId: `ilink-user-${randomUUID()}`,
    remark: "database fixture",
    enabled: true,
    authStatus: "active",
    maxSendsPerMinute: 6,
    botToken: `bot-token-${randomUUID()}`,
    baseUrl: "https://ilinkai.weixin.qq.com",
    webhookBearerHash: randomUUID().replaceAll("-", "").repeat(2),
    webhookBearerLastFour: "a1b2",
    now,
  }
}

export function createContextInput(
  botId: CreateBotInput["id"],
  suffix: number,
): UpsertContextInput {
  const hex = suffix.toString(16).padStart(8, "0")
  return {
    id: ContextIdSchema.parse(randomUUID()),
    botId,
    userId: `user-${suffix}@im.wechat`,
    userLookupHash: hex.padEnd(64, "a"),
    userFingerprint: `user_${hex}`,
    contextToken: `context-token-${suffix}`,
    now: EpochMillisecondsSchema.parse(1_800_000_000_000 + suffix),
  }
}

export function createAdmissionInput(
  bot: CreateBotInput,
  createdAtValue = 1_800_000_000_100,
): AdmissionInput {
  const createdAt = EpochMillisecondsSchema.parse(createdAtValue)
  const userFingerprint = bot.boundUserFingerprint
  if (userFingerprint === null) {
    throw new TestFixtureError("admission fixture requires a bound user")
  }
  return {
    invocation: {
      id: InvocationIdSchema.parse(randomUUID()),
      requestId: InvocationIdSchema.parse(randomUUID()),
      endpoint: "single",
      botId: bot.id,
      idempotencyScope: `single:${bot.id}`,
      idempotencyKeyHash: randomUUID().replaceAll("-", "").repeat(2),
      requestDigest: randomUUID().replaceAll("-", "").repeat(2),
      userFingerprint,
      deadlineAt: EpochMillisecondsSchema.parse(createdAtValue + 60_000),
      createdAt,
    },
    job: {
      id: JobIdSchema.parse(randomUUID()),
      clientId: `clawbot-${randomUUID()}`,
      botId: bot.id,
      recipient: "recipient@im.wechat",
      recipientLookupHash: "b".repeat(64),
      userFingerprint,
      text: "hello from Task 4",
      contextToken: "context-token-1",
      admissionEstimatedAt: createdAt,
      retryNotBefore: createdAt,
      deadlineAt: EpochMillisecondsSchema.parse(createdAtValue + 60_000),
      createdAt,
    },
  }
}

export function createAttemptInput(jobId: AdmissionInput["job"]["id"]): RecordAttemptInput {
  return {
    id: AttemptIdSchema.parse(randomUUID()),
    jobId,
    attempt: 1,
    classification: "in_flight",
    startedAt: EpochMillisecondsSchema.parse(1_800_000_000_200),
  }
}
