import { render, screen } from "@testing-library/react"
import { createElement } from "react"
import { describe, expect, it } from "vitest"

import HomePage from "./page"

describe("HomePage", () => {
  it("renders the bootstrap route", () => {
    // Given: a bootstrap page component.
    // When: the route is rendered.
    render(createElement(HomePage))

    // Then: its primary page heading is available.
    expect(screen.getByRole("heading", { name: "Clawbot bootstrap" }).textContent).toBe(
      "Clawbot bootstrap",
    )
  })
})
