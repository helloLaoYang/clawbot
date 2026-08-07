import { getAuthenticationRuntime } from "@/server/auth/runtime"

export const runtime = "nodejs"

export async function POST(request: Request): Promise<Response> {
  return getAuthenticationRuntime().admin.login(request)
}
