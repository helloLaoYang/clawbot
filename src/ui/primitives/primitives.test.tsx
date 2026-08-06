import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Input } from "antd"
import { createElement } from "react"
import { beforeAll, describe, expect, it } from "vitest"

import { UiProvider } from "../provider"
import {
  DataTable,
  EmptyState,
  ErrorState,
  FormField,
  PrimitiveGrid,
  PrimitivePanel,
  StatusLabel,
} from "./primitives"

beforeAll(() => {
  const matchMedia: typeof window.matchMedia = (query) => ({
    addEventListener: () => undefined,
    addListener: () => undefined,
    dispatchEvent: () => false,
    matches: false,
    media: query,
    onchange: null,
    removeEventListener: () => undefined,
    removeListener: () => undefined,
  })

  window.matchMedia = matchMedia
})

describe("design primitives", () => {
  it("renders semantic labels when status, form, empty, and error states are shown", () => {
    render(
      createElement(
        UiProvider,
        undefined,
        createElement(
          PrimitivePanel,
          { title: "Delivery controls" },
          createElement(StatusLabel, { kind: "success" }, "Delivery healthy"),
          createElement(
            FormField,
            { label: "Endpoint", controlId: "endpoint", help: "HTTPS destination" },
            createElement(Input, { id: "endpoint" }),
          ),
          createElement(EmptyState, { description: "No deliveries match this filter." }),
          createElement(ErrorState, { description: "Reconnect the delivery source." }),
          createElement(DataTable, {
            columns: [{ dataIndex: "event", key: "event", title: "Event" }],
            dataSource: [{ event: "Delivery received", key: "delivery" }],
          }),
        ),
      ),
    )

    expect(screen.getByRole("status", { name: "Delivery healthy" }).textContent).toBe(
      "Delivery healthy",
    )
    expect(screen.getByLabelText("Endpoint").getAttribute("id")).toBe("endpoint")
    expect(screen.getByText("No deliveries match this filter.")).toBeTruthy()
    expect(screen.getByRole("alert").textContent).toContain("Reconnect the delivery source.")
    expect(screen.getByRole("table")).toBeTruthy()
  })

  it("keeps an Ant Design control reachable by keyboard focus", async () => {
    const user = userEvent.setup()

    render(
      createElement(
        UiProvider,
        undefined,
        createElement(
          FormField,
          { label: "Retry policy", controlId: "retry-policy" },
          createElement(Input, { id: "retry-policy" }),
        ),
      ),
    )

    await user.tab()

    expect(document.activeElement?.getAttribute("id")).toBe("retry-policy")
  })

  it("declares the 375, 768, and 1280 responsive grid contract", () => {
    render(
      createElement(
        UiProvider,
        undefined,
        createElement(
          PrimitiveGrid,
          undefined,
          createElement(PrimitivePanel, { title: "Responsive showcase" }, "Grid item"),
        ),
      ),
    )

    const grid = screen.getByRole("region", { name: "Responsive showcase" }).parentElement
    expect(grid?.className).toContain("ui-responsive-grid")
    expect(grid?.getAttribute("data-responsive-contract")).toBe("stack@375 grid@768 grid@1280")
  })

  it("wraps primitive content in the Ant Design registry provider", () => {
    render(createElement(UiProvider, undefined, createElement("p", undefined, "Registry child")))

    expect(screen.getByTestId("ui-provider").getAttribute("data-ui-registry")).toBe("antd")
  })
})
