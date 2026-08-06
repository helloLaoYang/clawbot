import type { TableProps } from "antd"
import { Alert, Empty, Table, Tag } from "antd"
import type { ReactNode } from "react"
import { useId } from "react"

import styles from "./primitives.module.css"

const statusColors = {
  error: "error",
  info: "processing",
  success: "success",
  warning: "warning",
} as const

type StatusKind = keyof typeof statusColors

export type PrimitivePanelProps = Readonly<{
  children?: ReactNode
  title: string
}>

export function PrimitivePanel({ children, title }: PrimitivePanelProps) {
  const headingId = useId()

  return (
    <section aria-labelledby={headingId} className={styles["panel"]}>
      <h2 className={styles["panelHeading"]} id={headingId}>
        {title}
      </h2>
      <div className={styles["panelBody"]}>{children}</div>
    </section>
  )
}

export function PrimitiveGrid({ children }: Readonly<{ children?: ReactNode }>) {
  return (
    <div className="ui-responsive-grid" data-responsive-contract="stack@375 grid@768 grid@1280">
      {children}
    </div>
  )
}

export function StatusLabel({ children, kind }: Readonly<{ children?: string; kind: StatusKind }>) {
  return (
    <span aria-label={children} role="status">
      <Tag color={statusColors[kind]}>{children}</Tag>
    </span>
  )
}

export function FormField({
  children,
  controlId,
  error,
  help,
  label,
}: Readonly<{
  children?: ReactNode
  controlId: string
  error?: string
  help?: string
  label: string
}>) {
  return (
    <div className={styles["field"]}>
      <label className={styles["fieldLabel"]} htmlFor={controlId}>
        {label}
      </label>
      {children}
      {help ? <p className={styles["fieldHelp"]}>{help}</p> : null}
      {error ? (
        <p className={styles["fieldError"]} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export type DataTableProps<RecordType extends object> = Readonly<{
  columns: NonNullable<TableProps<RecordType>["columns"]>
  dataSource: NonNullable<TableProps<RecordType>["dataSource"]>
  loading?: boolean
}>

export function DataTable<RecordType extends object>({
  columns,
  dataSource,
  loading = false,
}: DataTableProps<RecordType>) {
  return (
    <div className="ui-showcase__table">
      <Table<RecordType>
        columns={columns}
        dataSource={dataSource}
        loading={loading}
        pagination={false}
        rowKey="key"
      />
    </div>
  )
}

export function EmptyState({ description }: Readonly<{ description: string }>) {
  return <Empty description={description} image={Empty.PRESENTED_IMAGE_SIMPLE} />
}

export function ErrorState({ description }: Readonly<{ description: string }>) {
  return <Alert description={description} showIcon title="Delivery action failed" type="error" />
}
