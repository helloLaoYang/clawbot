// @vitest-environment node

import { describe } from "vitest"

import { registerOwnerRouteAuthBehavior } from "./route-auth.owner.real-http.behavior"
import { useRouteAuthFixture } from "./route-auth.real-http.fixture"
import { registerUnauthorizedRouteAuthBehavior } from "./route-auth.unauthorized.real-http.behavior"

describe("route-bound Bearer authentication", () => {
  const fixture = useRouteAuthFixture()

  registerUnauthorizedRouteAuthBehavior(fixture)
  registerOwnerRouteAuthBehavior(fixture)
})
