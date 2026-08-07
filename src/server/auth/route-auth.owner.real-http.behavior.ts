import { expect, it } from "vitest"

import type { RouteAuthFixtureAccessor } from "./route-auth.real-http.fixture"

export function registerOwnerRouteAuthBehavior(fixture: RouteAuthFixtureAccessor): void {
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
}
