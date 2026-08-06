import type { TableProps } from "antd"
import { Button, Input } from "antd"

import {
  DataTable,
  EmptyState,
  ErrorState,
  FormField,
  PrimitiveGrid,
  PrimitivePanel,
  StatusLabel,
} from "@/ui/primitives/primitives"
import { UiProvider } from "@/ui/provider"

type DeliveryRecord = {
  readonly event: string
  readonly key: string
  readonly result: string
}

const deliveryColumns = [
  { dataIndex: "event", key: "event", title: "Event" },
  { dataIndex: "result", key: "result", title: "Result" },
] satisfies NonNullable<TableProps<DeliveryRecord>["columns"]>

const deliveryRows = [
  { event: "message.received", key: "delivery-1", result: "Accepted" },
  { event: "message.failed", key: "delivery-2", result: "Retry pending" },
] satisfies NonNullable<TableProps<DeliveryRecord>["dataSource"]>

export default function ShowcasePage() {
  return (
    <UiProvider>
      <main className="ui-showcase">
        <div className="ui-showcase__content">
          <header className="ui-showcase__heading">
            <p className="ui-showcase__description">Clawbot UI foundation</p>
            <h1 className="ui-showcase__title">Operational primitives</h1>
            <p className="ui-showcase__description">
              Accessible building blocks for webhook delivery monitoring and recovery flows.
            </p>
          </header>

          <PrimitiveGrid>
            <PrimitivePanel title="Status labels">
              <div className="ui-showcase__cluster">
                <StatusLabel kind="success">Delivery healthy</StatusLabel>
                <StatusLabel kind="warning">Retry pending</StatusLabel>
                <StatusLabel kind="error">Delivery failed</StatusLabel>
                <StatusLabel kind="info">Configuration saved</StatusLabel>
              </div>
            </PrimitivePanel>

            <PrimitivePanel title="Form field">
              <FormField
                controlId="showcase-endpoint"
                help="Use an HTTPS endpoint that can accept webhook requests."
                label="Endpoint"
              >
                <Input id="showcase-endpoint" placeholder="https://example.test/webhooks" />
              </FormField>
            </PrimitivePanel>

            <PrimitivePanel title="Recovery action">
              <div className="ui-showcase__cluster">
                <Button type="primary">Retry delivery</Button>
                <Button>View event</Button>
              </div>
            </PrimitivePanel>
          </PrimitiveGrid>

          <PrimitivePanel title="Delivery table">
            <DataTable columns={deliveryColumns} dataSource={deliveryRows} />
          </PrimitivePanel>

          <PrimitiveGrid>
            <PrimitivePanel title="Empty state">
              <EmptyState description="No deliveries match this filter." />
            </PrimitivePanel>
            <PrimitivePanel title="Error state">
              <ErrorState description="Reconnect the delivery source, then retry the webhook." />
            </PrimitivePanel>
          </PrimitiveGrid>
        </div>
      </main>
    </UiProvider>
  )
}
