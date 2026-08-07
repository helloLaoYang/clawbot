import type { BearerHash } from "../config/config"
import { BearerHashSchema } from "../config/config"
import { verifyBearer } from "../crypto/bearer"
import type { BotRecord } from "../db/contracts"
import { BotPublicIdSchema } from "../db/ids"
import type { BotRepository } from "../db/repositories/contracts"
import { createErrorResponse } from "./http"

const UNKNOWN_BEARER_HASH = BearerHashSchema.parse("0".repeat(64))
const BEARER_PATTERN = /^Bearer ([^\s]+)$/i

export type CredentialAuthentication =
  | { readonly kind: "authenticated" }
  | { readonly kind: "unauthorized"; readonly response: Response }

export type BotAuthentication =
  | { readonly bot: BotRecord; readonly kind: "authenticated" }
  | { readonly kind: "unauthorized"; readonly response: Response }

function readBearer(request: Request): string | null {
  return BEARER_PATTERN.exec(request.headers.get("authorization") ?? "")?.at(1) ?? null
}

function unauthorized(): { readonly kind: "unauthorized"; readonly response: Response } {
  return {
    kind: "unauthorized",
    response: createErrorResponse("unauthorized", 401, { bearerChallenge: true }),
  }
}

export function authenticateAdminBearer(
  request: Request,
  expectedHash: BearerHash,
): CredentialAuthentication {
  const bearer = readBearer(request)
  return bearer !== null && verifyBearer(bearer, expectedHash)
    ? { kind: "authenticated" }
    : unauthorized()
}

export function authenticateBotBearer(
  request: Request,
  publicId: string,
  bots: BotRepository,
): BotAuthentication {
  const bearer = readBearer(request)
  if (bearer === null) {
    return unauthorized()
  }
  const parsedPublicId = BotPublicIdSchema.safeParse(publicId)
  const bot = parsedPublicId.success ? bots.findByPublicId(parsedPublicId.data) : null
  const credentials = bot === null ? null : bots.getCredentials(bot.id)
  const expectedHash =
    credentials === null
      ? UNKNOWN_BEARER_HASH
      : BearerHashSchema.parse(credentials.webhookBearerHash)
  const matches = verifyBearer(bearer, expectedHash)
  return matches && bot !== null && credentials !== null
    ? { bot, kind: "authenticated" }
    : unauthorized()
}
