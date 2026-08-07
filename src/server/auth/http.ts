import { randomUUID } from "node:crypto"

import type { AdminSessionToken } from "../crypto/admin-auth"

export const ADMIN_SESSION_COOKIE_NAME = "clawbot_admin_session" as const

type ErrorCode =
  | "deadline_exceeded"
  | "invalid_json"
  | "invalid_state"
  | "not_found"
  | "qr_expired"
  | "qr_poll_in_progress"
  | "rate_limited"
  | "unauthorized"
  | "upstream_failed"
  | "validation_failed"
type ErrorResponseOptions = Readonly<{
  bearerChallenge?: boolean
  retryAfterSeconds?: number
  retryable?: boolean
}>

const ERROR_MESSAGES = {
  deadline_exceeded: "Upstream request deadline exceeded",
  invalid_json: "Invalid request",
  invalid_state: "Request is invalid for the current state",
  not_found: "Not found",
  qr_expired: "QR session expired",
  qr_poll_in_progress: "QR poll already in progress",
  rate_limited: "Too many requests",
  unauthorized: "Unauthorized",
  upstream_failed: "Upstream request failed",
  validation_failed: "Request validation failed",
} as const satisfies Record<ErrorCode, string>

function responseHeaders(requestId: string): Headers {
  return new Headers({
    "cache-control": "no-store",
    "x-request-id": requestId,
  })
}

export function createErrorResponse(
  code: ErrorCode,
  status: number,
  options: ErrorResponseOptions = {},
): Response {
  const requestId = randomUUID()
  const headers = responseHeaders(requestId)
  if (options.bearerChallenge === true) {
    headers.set("www-authenticate", "Bearer")
  }
  if (options.retryAfterSeconds !== undefined) {
    headers.set("retry-after", String(options.retryAfterSeconds))
  }
  return Response.json(
    {
      error: {
        code,
        message: ERROR_MESSAGES[code],
        request_id: requestId,
        retryable: options.retryable ?? false,
      },
    },
    { headers, status },
  )
}

export function createJsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { headers: responseHeaders(randomUUID()), status })
}

export function createEmptyResponse(status: 204, setCookie?: string): Response {
  const headers = responseHeaders(randomUUID())
  if (setCookie !== undefined) {
    headers.set("set-cookie", setCookie)
  }
  return new Response(null, { headers, status })
}

export function hasAllowedOrigin(request: Request, allowedOrigin: string): boolean {
  return request.headers.get("origin") === allowedOrigin
}

export function readAdminSessionCookie(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie")
  if (cookieHeader === null) {
    return null
  }
  const values = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${ADMIN_SESSION_COOKIE_NAME}=`))
    .map((part) => part.slice(ADMIN_SESSION_COOKIE_NAME.length + 1))
  return values.length === 1 ? (values.at(0) ?? null) : null
}

export function serializeAdminSessionCookie(
  token: AdminSessionToken,
  expiresAt: number,
  secure: boolean,
): string {
  const attributes = [
    `${ADMIN_SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=28800",
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ]
  if (secure) {
    attributes.push("Secure")
  }
  return attributes.join("; ")
}

export function serializeClearedAdminSessionCookie(secure: boolean): string {
  const attributes = [
    `${ADMIN_SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ]
  if (secure) {
    attributes.push("Secure")
  }
  return attributes.join("; ")
}
