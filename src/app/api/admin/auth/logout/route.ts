import { getAuthenticationRuntime } from "@/server/auth/runtime"

export const runtime = "nodejs"

export function POST(request: Request): Response {
  return getAuthenticationRuntime().admin.logout(request)
}
