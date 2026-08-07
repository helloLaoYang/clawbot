import { expect, it } from "vitest"
import { z } from "zod"

import type { RouteAuthFixtureAccessor } from "./route-auth.real-http.fixture"

const UnauthorizedResponseSchema = z.object({
  error: z
    .object({
      code: z.literal("unauthorized"),
      request_id: z.string().uuid(),
      retryable: z.literal(false),
    })
    .passthrough(),
})

export function registerUnauthorizedRouteAuthBehavior(fixture: RouteAuthFixtureAccessor): void {
  it("returns generic Bearer 401 responses for valid cross-domain credentials", async () => {
    // Given: valid UI, administrator, and bot credentials sent to another domain's planned API.
    const running = fixture()
    const requests = [
      { headers: { cookie: running.sessionCookie }, path: running.adminPath },
      { headers: { cookie: running.sessionCookie }, path: running.botPath },
      { headers: { authorization: `Bearer ${running.adminBearer}` }, path: running.botPath },
      { headers: { authorization: `Bearer ${running.botBearer}` }, path: running.adminPath },
    ] as const

    // When: each request traverses the real Next HTTP router.
    const responses = await Promise.all(
      requests.map(({ headers, path }) => running.request(path, headers)),
    )

    // Then: authentication responds before unresolved-route handling, generically and without CORS.
    for (const response of responses) {
      expect(response.statusCode, `${response.body}\n${running.readServerOutput()}`).toBe(401)
      expect(response.headers["cache-control"]).toBe("no-store")
      expect(response.headers["www-authenticate"]).toBe("Bearer")
      expect(response.headers["content-type"]).toContain("application/json")
      expect(response.headers["access-control-allow-origin"]).toBeUndefined()
      UnauthorizedResponseSchema.parse(JSON.parse(response.body))
    }
  })
}
