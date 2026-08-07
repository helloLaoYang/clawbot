// @vitest-environment node

import { Buffer } from "node:buffer"
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { request as sendHttpRequest } from "node:http"
import { createServer } from "node:net"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

import { AppEncryptionKeySchema, SessionSecretSchema } from "../config/config"
import { createAdminSession } from "../crypto/admin-auth"
import { hashBearer } from "../crypto/bearer"
import { decryptField, encryptField } from "../crypto/envelope"
import { deriveCryptoKeys } from "../crypto/keys"
import type { FieldCipher } from "../db/contracts"
import { openDatabase } from "../db/database"
import { createBotInput } from "../db/test-support/fixtures"
import { ADMIN_SESSION_COOKIE_NAME } from "./admin"

const QA_ROOT = "/tmp/clawbot-qa"
const ADMIN_BEARER = "A".repeat(43)
const BOT_BEARER = "B".repeat(43)
const APP_KEY = AppEncryptionKeySchema.parse(Buffer.alloc(32, 17).toString("base64"))
const SESSION_SECRET = SessionSecretSchema.parse(Buffer.alloc(32, 29).toString("base64"))
const PASSWORD_HASH =
  "scrypt$v1$32768$8$1$AAECAwQFBgcICQoLDA0ODw$eo40JB24mNWRdcaWU4xBdGepdf_laQaEJfFhiNMVnFg"

const UnauthorizedResponseSchema = z.object({
  error: z
    .object({
      code: z.literal("unauthorized"),
      request_id: z.string().uuid(),
      retryable: z.literal(false),
    })
    .passthrough(),
})

type HttpResponse = Readonly<{
  body: string
  headers: Readonly<Record<string, string | readonly string[] | undefined>>
  statusCode: number
}>

type RunningFixture = Readonly<{
  adminPath: string
  baseUrl: string
  botPath: string
  process: ChildProcessWithoutNullStreams
  sessionCookie: string
}>

class RealHttpFixtureError extends Error {
  readonly name = "RealHttpFixtureError"
}

let fixture: RunningFixture | undefined
let projectPath: string | undefined
let serverOutput = ""

function createFieldCipher(): FieldCipher {
  const keys = deriveCryptoKeys(APP_KEY)
  return {
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
}

async function reservePort(): Promise<number> {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (address === null || typeof address === "string") {
    server.close()
    throw new RealHttpFixtureError("ephemeral HTTP port was unavailable")
  }
  const port = address.port
  server.close()
  await once(server, "close")
  return port
}

function waitForReady(process: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new RealHttpFixtureError(`Next server did not start: ${serverOutput}`)),
      30_000,
    )
    const receive = (chunk: Buffer) => {
      serverOutput += chunk.toString("utf8")
      if (serverOutput.includes("Ready in")) {
        clearTimeout(timeout)
        resolve()
      }
    }
    process.stdout.on("data", receive)
    process.stderr.on("data", receive)
    process.once("exit", (code) => {
      clearTimeout(timeout)
      reject(new RealHttpFixtureError(`Next server exited ${String(code)}: ${serverOutput}`))
    })
  })
}

async function stopServer(process: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.exitCode !== null) {
    return
  }
  const exited = once(process, "exit", { signal: AbortSignal.timeout(10_000) })
  const processId = process.pid
  if (processId === undefined) {
    process.kill("SIGTERM")
  } else {
    globalThis.process.kill(-processId, "SIGTERM")
  }
  await exited
}

function sendRequest(url: URL, headers: Readonly<Record<string, string>>): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const request = sendHttpRequest(
      url,
      {
        headers: { "content-type": "application/json", ...headers },
        method: "POST",
        signal: AbortSignal.timeout(15_000),
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
            statusCode: response.statusCode ?? 0,
          }),
        )
      },
    )
    request.once("error", (error) =>
      reject(
        new RealHttpFixtureError(`real HTTP request failed: ${serverOutput}`, { cause: error }),
      ),
    )
    request.end("{}")
  })
}

beforeAll(async () => {
  mkdirSync(QA_ROOT, { recursive: true })
  const repository = process.cwd()
  projectPath = mkdtempSync(join(QA_ROOT, "task-6-route-auth-project-"))

  const databasePath = join(projectPath, "clawbot.sqlite")
  const database = openDatabase({
    cipher: createFieldCipher(),
    environment: "test",
    filesystemProbe: { statfsType: () => 0xef53 },
    path: databasePath,
  })
  const bot = createBotInput()
  database.bots.create({ ...bot, webhookBearerHash: hashBearer(BOT_BEARER) })
  database.close()

  const port = await reservePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const nextProcess = spawn(
    process.execPath,
    [
      join(repository, "node_modules/next/dist/bin/next"),
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: repository,
      detached: true,
      env: {
        ...process.env,
        ADMIN_ALLOWED_ORIGIN: baseUrl,
        ADMIN_API_BEARER_HASH: hashBearer(ADMIN_BEARER),
        ADMIN_BATCH_MAX_BOTS: "20",
        ADMIN_PASSWORD_HASH: PASSWORD_HASH,
        APP_ENCRYPTION_KEY: APP_KEY,
        DATABASE_PATH: databasePath,
        DEFAULT_BOT_MAX_SENDS_PER_MINUTE: "1",
        NEXT_MANUAL_SIG_HANDLE: "false",
        NODE_ENV: "development",
        PORT: String(port),
        SESSION_SECRET,
        TENCENT_MAX_SENDS_PER_MINUTE: "60",
      },
      stdio: "pipe",
    },
  )
  await waitForReady(nextProcess)
  fixture = {
    adminPath: "/api/v1/admin/messages/batch",
    baseUrl,
    botPath: `/api/v1/bots/${bot.publicId}/messages`,
    process: nextProcess,
    sessionCookie: `${ADMIN_SESSION_COOKIE_NAME}=${createAdminSession(SESSION_SECRET).token}`,
  }
}, 60_000)

afterAll(async () => {
  if (fixture !== undefined) {
    await stopServer(fixture.process)
  }
  if (projectPath !== undefined) {
    rmSync(projectPath, { force: true, recursive: true })
  }
}, 30_000)

describe("route-bound Bearer authentication", () => {
  it("returns generic Bearer 401 responses for valid cross-domain credentials", async () => {
    // Given: valid UI, administrator, and bot credentials sent to another domain's planned API.
    if (fixture === undefined) {
      throw new RealHttpFixtureError("real HTTP fixture was not initialized")
    }
    const requests = [
      { headers: { cookie: fixture.sessionCookie }, path: fixture.adminPath },
      { headers: { cookie: fixture.sessionCookie }, path: fixture.botPath },
      { headers: { authorization: `Bearer ${ADMIN_BEARER}` }, path: fixture.botPath },
      { headers: { authorization: `Bearer ${BOT_BEARER}` }, path: fixture.adminPath },
    ] as const

    // When: each request traverses the real Next HTTP router.
    const responses = await Promise.all(
      requests.map(({ headers, path }) => sendRequest(new URL(path, fixture?.baseUrl), headers)),
    )

    // Then: authentication responds before unresolved-route handling, generically and without CORS.
    for (const response of responses) {
      expect(response.statusCode, `${response.body}\n${serverOutput}`).toBe(401)
      expect(response.headers["cache-control"]).toBe("no-store")
      expect(response.headers["www-authenticate"]).toBe("Bearer")
      expect(response.headers["content-type"]).toContain("application/json")
      expect(response.headers["access-control-allow-origin"]).toBeUndefined()
      UnauthorizedResponseSchema.parse(JSON.parse(response.body))
    }
  })

  it("lets owner credentials continue to the still-unimplemented planned handlers", async () => {
    // Given: valid administrator and bot credentials for their own planned APIs.
    if (fixture === undefined) {
      throw new RealHttpFixtureError("real HTTP fixture was not initialized")
    }

    // When: both requests traverse route-bound authentication.
    const responses = await Promise.all([
      sendRequest(new URL(fixture.adminPath, fixture.baseUrl), {
        authorization: `Bearer ${ADMIN_BEARER}`,
      }),
      sendRequest(new URL(fixture.botPath, fixture.baseUrl), {
        authorization: `Bearer ${BOT_BEARER}`,
      }),
    ])

    // Then: Next retains ownership of the unimplemented routes instead of a fake handler responding.
    expect(
      responses.map(({ statusCode }) => statusCode),
      `${responses.map(({ body }) => body).join("\n")}\n${serverOutput}`,
    ).toEqual([404, 404])
  })
})
