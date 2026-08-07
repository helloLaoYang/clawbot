// @vitest-environment node

import { describe, expect, it } from "vitest"
import { z } from "zod"

import { useRouteAuthFixture } from "./route-auth.real-http.fixture"

const UnauthorizedResponseSchema = z.object({
  error: z
    .object({
      code: z.literal("unauthorized"),
      request_id: z.string().uuid(),
      retryable: z.literal(false),
    })
    .passthrough(),
})

describe("route-bound Bearer authentication", () => {
  const fixture = useRouteAuthFixture()

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

  it("lets owner credentials continue to the still-unimplemented planned handlers", async () => {
    // Given: valid administrator and bot credentials for their own planned APIs.
    const running = fixture()

    // When: both requests traverse route-bound authentication.
    const responses = await Promise.all([
      running.request(running.adminPath, {
        authorization: `Bearer ${running.adminBearer}`,
      }),
      running.request(running.botPath, {
        authorization: `Bearer ${running.botBearer}`,
      }),
    ])

    // Then: Next retains ownership of the unimplemented routes instead of a fake handler responding.
    expect(
      responses.map(({ statusCode }) => statusCode),
      `${responses.map(({ body }) => body).join("\n")}\n${running.readServerOutput()}`,
    ).toEqual([404, 404])
  })
})
