import { getAuthenticationRuntime } from "@/server/auth/runtime"

export const runtime = "nodejs"

export function GET(request: Request): Response {
  return getAuthenticationRuntime().admin.session(request)
}
