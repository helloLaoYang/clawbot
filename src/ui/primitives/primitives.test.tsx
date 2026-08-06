import { render, screen, waitFor } from "@testing-library/react"
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
  it("renders every documented semantic status label", () => {
    const statusFixtures = [
      { kind: "success", label: "Delivery healthy" },
      { kind: "warning", label: "Retry pending" },
      { kind: "error", label: "Delivery failed" },
      { kind: "info", label: "Configuration saved" },
    ] as const

    render(
      createElement(
        UiProvider,
        undefined,
        statusFixtures.map((status) =>
          createElement(StatusLabel, { key: status.kind, kind: status.kind }, status.label),
        ),
      ),
    )

    for (const status of statusFixtures) {
      expect(screen.getByRole("status", { name: status.label }).textContent).toBe(status.label)
    }
  })

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

  it("renders default, help, disabled, and error form field states", () => {
    render(
      createElement(
        UiProvider,
        undefined,
        createElement(
          FormField,
          {
            controlId: "delivery-endpoint",
            error: "Use a reachable HTTPS endpoint.",
            help: "The endpoint receives webhook deliveries.",
            label: "Delivery endpoint",
          },
          createElement(Input, { disabled: true, id: "delivery-endpoint" }),
        ),
      ),
    )

    expect(screen.getByLabelText("Delivery endpoint").hasAttribute("disabled")).toBe(true)
    expect(screen.getByText("The endpoint receives webhook deliveries.")).toBeTruthy()
    expect(screen.getByRole("alert").textContent).toBe("Use a reachable HTTPS endpoint.")
  })

  it("renders populated, empty, and loading data table states", async () => {
    const { container, rerender } = render(
      createElement(
        UiProvider,
        undefined,
        createElement(DataTable, {
          columns: [{ dataIndex: "event", key: "event", title: "Event" }],
          dataSource: [{ event: "Delivery received", key: "delivery" }],
        }),
      ),
    )

    expect(screen.getByRole("cell", { name: "Delivery received" }).textContent).toBe(
      "Delivery received",
    )
    expect(container.querySelector('[aria-busy="false"]')).toBeTruthy()

    rerender(
      createElement(
        UiProvider,
        undefined,
        createElement(DataTable, {
          columns: [{ dataIndex: "event", key: "event", title: "Event" }],
          dataSource: [],
        }),
      ),
    )

    expect(screen.getAllByText("No data").length).toBeGreaterThan(0)

    rerender(
      createElement(
        UiProvider,
        undefined,
        createElement(DataTable, {
          columns: [{ dataIndex: "event", key: "event", title: "Event" }],
          dataSource: [],
          loading: true,
        }),
      ),
    )

    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeTruthy()
    })
  })

  it("fails the label accessibility assertion for an unlabeled control fixture", () => {
    render(createElement(Input, { id: "unlabeled-endpoint" }))

    expect(() => screen.getByLabelText("Endpoint")).toThrow()
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
