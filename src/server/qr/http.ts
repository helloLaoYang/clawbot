import { authenticateAdminSession, type Clock } from "../auth/admin"
import { createErrorResponse, createJsonResponse, hasAllowedOrigin } from "../auth/http"
import type { SessionSecret } from "../config/config"
import type { AdminSessionId } from "../crypto/admin-auth"
import {
  type QrFailure,
  type QrResult,
  QrSessionIdSchema,
  StartQrSessionRequestSchema,
  VerifyQrCodeRequestSchema,
} from "./contracts"
import type { QrOnboardingService } from "./service"

type QrHttpOptions = Readonly<{
  allowedOrigin: string
  clock: Clock
  service: QrOnboardingService
  sessionSecret: SessionSecret
}>

export type QrHttpHandlers = Readonly<{
  poll(request: Request, sessionId: string): Promise<Response>
  start(request: Request): Promise<Response>
  verifyCode(request: Request, sessionId: string): Promise<Response>
}>

type QrAuthentication =
  | { readonly kind: "authenticated"; readonly ownerId: AdminSessionId }
  | { readonly kind: "unauthorized"; readonly response: Response }

async function readJson(request: Request): Promise<unknown | Response> {
  try {
    return await request.json()
  } catch (error) {
    if (error instanceof SyntaxError) {
      return createErrorResponse("invalid_json", 400)
    }
    throw error
  }
}

function resultResponse<T>(result: QrResult<T>, successStatus = 200): Response {
  if (result.kind === "ok") {
    return createJsonResponse(result.value, successStatus)
  }
  return failureResponse(result)
}

function failureResponse(failure: QrFailure): Response {
  switch (failure.kind) {
    case "deadline_exceeded":
      return createErrorResponse("deadline_exceeded", 504, { retryable: true })
    case "expired":
      return createErrorResponse("qr_expired", 410)
    case "invalid_state":
      return createErrorResponse("invalid_state", 409)
    case "not_found":
      return createErrorResponse("not_found", 404)
    case "poll_in_progress":
      return createErrorResponse("qr_poll_in_progress", 409, { retryable: true })
    case "upstream_failed":
      return createErrorResponse("upstream_failed", 502, { retryable: true })
    default:
      return assertNever(failure)
  }
}

export function createQrHttpHandlers(options: QrHttpOptions): QrHttpHandlers {
  const authenticate = (request: Request): QrAuthentication => {
    if (!hasAllowedOrigin(request, options.allowedOrigin)) {
      return { kind: "unauthorized", response: createErrorResponse("unauthorized", 401) }
    }
    const authentication = authenticateAdminSession(
      request,
      options.sessionSecret,
      options.clock.now(),
    )
    return authentication.kind === "unauthorized"
      ? authentication
      : { kind: "authenticated", ownerId: authentication.session.id }
  }

  return {
    async poll(request, sessionIdValue) {
      const authentication = authenticate(request)
      if (authentication.kind === "unauthorized") {
        return authentication.response
      }
      const sessionId = QrSessionIdSchema.safeParse(sessionIdValue)
      if (!sessionId.success) {
        return createErrorResponse("not_found", 404)
      }
      return resultResponse(
        await options.service.poll({ ownerId: authentication.ownerId, sessionId: sessionId.data }),
      )
    },
    async start(request) {
      const authentication = authenticate(request)
      if (authentication.kind === "unauthorized") {
        return authentication.response
      }
      const body = await readJson(request)
      if (body instanceof Response) {
        return body
      }
      const parsed = StartQrSessionRequestSchema.safeParse(body)
      if (!parsed.success) {
        return createErrorResponse("validation_failed", 422)
      }
      return resultResponse(
        await options.service.start({
          ownerId: authentication.ownerId,
          ...(parsed.data.bot_public_id === undefined
            ? {}
            : { botPublicId: parsed.data.bot_public_id }),
        }),
        201,
      )
    },
    async verifyCode(request, sessionIdValue) {
      const authentication = authenticate(request)
      if (authentication.kind === "unauthorized") {
        return authentication.response
      }
      const sessionId = QrSessionIdSchema.safeParse(sessionIdValue)
      if (!sessionId.success) {
        return createErrorResponse("not_found", 404)
      }
      const body = await readJson(request)
      if (body instanceof Response) {
        return body
      }
      const parsed = VerifyQrCodeRequestSchema.safeParse(body)
      if (!parsed.success) {
        return createErrorResponse("validation_failed", 422)
      }
      return resultResponse(
        await options.service.verifyCode({
          ownerId: authentication.ownerId,
          sessionId: sessionId.data,
          verifyCode: parsed.data.verify_code,
        }),
      )
    },
  }
}

function assertNever(value: never): never {
  return value
}
