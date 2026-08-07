import { z } from "zod"

import type { AdminPasswordHash, SessionSecret } from "../config/config"
import {
  createAdminSession,
  type VerifiedAdminSession,
  verifyAdminPassword,
  verifyAdminSession,
} from "../crypto/admin-auth"
import type { AdminLoginState } from "../db/contracts"
import { EpochMillisecondsSchema } from "../db/ids"
import type { RuntimeRepository } from "../db/repositories/contracts"
import {
  ADMIN_SESSION_COOKIE_NAME,
  createEmptyResponse,
  createErrorResponse,
  createJsonResponse,
  hasAllowedOrigin,
  readAdminSessionCookie,
  serializeAdminSessionCookie,
  serializeClearedAdminSessionCookie,
} from "./http"

export { ADMIN_SESSION_COOKIE_NAME }

export const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1_000
const ADMIN_MAX_FAILED_ATTEMPTS = 5

const LoginRequestSchema = z.object({ password: z.string() }).strict().readonly()

export interface Clock {
  now(): number
}

type AdminAuthOptions = Readonly<{
  allowedOrigin: string
  clock: Clock
  passwordHash: AdminPasswordHash
  runtime: RuntimeRepository
  secureCookies: boolean
  sessionSecret: SessionSecret
}>

type LoginAttempt = Readonly<{
  now: ReturnType<typeof EpochMillisecondsSchema.parse>
  passwordMatches: boolean
}>

export type AdminSessionAuthentication =
  | { readonly kind: "authenticated"; readonly session: VerifiedAdminSession }
  | { readonly kind: "unauthorized"; readonly response: Response }

export type AdminAuthHandlers = Readonly<{
  login(request: Request): Promise<Response>
  logout(request: Request): Response
  session(request: Request): Response
}>

function nextAdminLoginState(current: AdminLoginState, attempt: LoginAttempt): AdminLoginState {
  if (current.lockedUntil !== null && current.lockedUntil > attempt.now) {
    return current
  }
  if (attempt.passwordMatches) {
    return {
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: attempt.now,
      windowStartedAt: null,
    }
  }

  const windowStartedAt =
    current.windowStartedAt !== null &&
    attempt.now < current.windowStartedAt + ADMIN_LOGIN_WINDOW_MS
      ? current.windowStartedAt
      : attempt.now
  const failedAttempts =
    windowStartedAt === current.windowStartedAt ? current.failedAttempts + 1 : 1
  return {
    failedAttempts,
    lockedUntil:
      failedAttempts >= ADMIN_MAX_FAILED_ATTEMPTS
        ? EpochMillisecondsSchema.parse(attempt.now + ADMIN_LOGIN_WINDOW_MS)
        : null,
    updatedAt: attempt.now,
    windowStartedAt,
  }
}

function retryAfterSeconds(lockedUntil: number, now: number): number {
  return Math.ceil((lockedUntil - now) / 1_000)
}

export function authenticateAdminSession(
  request: Request,
  secret: SessionSecret,
  now: number,
): AdminSessionAuthentication {
  const token = readAdminSessionCookie(request)
  if (token === null) {
    return { kind: "unauthorized", response: createErrorResponse("unauthorized", 401) }
  }
  const verified = verifyAdminSession(token, secret, now)
  if (verified.kind === "invalid") {
    return { kind: "unauthorized", response: createErrorResponse("unauthorized", 401) }
  }
  return { kind: "authenticated", session: verified.value }
}

export function createAdminAuthHandlers(options: AdminAuthOptions): AdminAuthHandlers {
  return {
    async login(request) {
      if (!hasAllowedOrigin(request, options.allowedOrigin)) {
        return createErrorResponse("unauthorized", 403)
      }

      let input: unknown
      try {
        input = await request.json()
      } catch (error) {
        if (error instanceof SyntaxError) {
          return createErrorResponse("invalid_json", 400)
        }
        throw error
      }
      const parsed = LoginRequestSchema.safeParse(input)
      if (!parsed.success) {
        return createErrorResponse("invalid_json", 400)
      }

      const now = EpochMillisecondsSchema.parse(options.clock.now())
      const current = options.runtime.getAdminLoginState()
      if (current.lockedUntil !== null && current.lockedUntil > now) {
        return createErrorResponse("rate_limited", 429, {
          retryAfterSeconds: retryAfterSeconds(current.lockedUntil, now),
          retryable: true,
        })
      }

      const passwordMatches = verifyAdminPassword(parsed.data.password, options.passwordHash)
      const state = options.runtime.updateAdminLoginState((persisted) =>
        nextAdminLoginState(persisted, { now, passwordMatches }),
      )
      if (state.lockedUntil !== null && state.lockedUntil > now) {
        return createErrorResponse("rate_limited", 429, {
          retryAfterSeconds: retryAfterSeconds(state.lockedUntil, now),
          retryable: true,
        })
      }
      if (!passwordMatches) {
        return createErrorResponse("unauthorized", 401)
      }

      const session = createAdminSession(options.sessionSecret, now)
      return createEmptyResponse(
        204,
        serializeAdminSessionCookie(session.token, session.expiresAt, options.secureCookies),
      )
    },
    logout(request) {
      if (!hasAllowedOrigin(request, options.allowedOrigin)) {
        return createErrorResponse("unauthorized", 403)
      }
      return createEmptyResponse(204, serializeClearedAdminSessionCookie(options.secureCookies))
    },
    session(request) {
      const authentication = authenticateAdminSession(
        request,
        options.sessionSecret,
        options.clock.now(),
      )
      if (authentication.kind === "unauthorized") {
        return authentication.response
      }
      return createJsonResponse({
        authenticated: true,
        expires_at: authentication.session.expiresAt,
      })
    },
  }
}
