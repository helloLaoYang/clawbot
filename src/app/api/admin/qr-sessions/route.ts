import { getAuthenticationRuntime } from "@/server/auth/runtime"

export const runtime = "nodejs"

export function POST(request: Request): Promise<Response> {
  return getAuthenticationRuntime().qr.start(request)
}
