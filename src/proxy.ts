import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

import { authenticateAdminBearer, authenticateBotBearer } from "@/server/auth/bearers"
import { getAuthenticationRuntime } from "@/server/auth/runtime"

const ADMIN_MESSAGES_PATH = "/api/v1/admin/messages/batch"
const BOT_MESSAGES_PATH = /^\/api\/v1\/bots\/([^/]+)\/messages$/

export function proxy(request: NextRequest): Response {
  if (request.method !== "POST") {
    return NextResponse.next()
  }

  const runtime = getAuthenticationRuntime()
  const authentication =
    request.nextUrl.pathname === ADMIN_MESSAGES_PATH
      ? authenticateAdminBearer(request, runtime.config.ADMIN_API_BEARER_HASH)
      : authenticateBotBearer(
          request,
          BOT_MESSAGES_PATH.exec(request.nextUrl.pathname)?.at(1) ?? "",
          runtime.database.bots,
        )

  return authentication.kind === "authenticated" ? NextResponse.next() : authentication.response
}

export const config = {
  matcher: ["/api/v1/admin/messages/batch", "/api/v1/bots/:botPublicId/messages"],
}
