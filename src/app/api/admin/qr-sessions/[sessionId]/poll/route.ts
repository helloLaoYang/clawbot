import { getAuthenticationRuntime } from "@/server/auth/runtime"

export const runtime = "nodejs"

type RouteContext = Readonly<{
  params: Promise<Readonly<{ sessionId: string }>>
}>

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { sessionId } = await context.params
  return getAuthenticationRuntime().qr.poll(request, sessionId)
}
