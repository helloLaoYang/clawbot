import type { TencentOperation } from "./protocol"

export type TencentProtocolFailure =
  | "malformed_response"
  | "nonzero_ret"
  | "request_too_large"
  | "response_too_large"

export type TencentErrorDetails =
  | { readonly kind: "aborted" }
  | { readonly kind: "invalid_origin" }
  | { readonly kind: "network" }
  | { readonly kind: "timeout" }
  | { readonly kind: "rate_limited"; readonly source: "http"; readonly status: 429 }
  | { readonly kind: "rate_limited"; readonly source: "protocol"; readonly ret: -2 }
  | { readonly kind: "reauth_required"; readonly ret: -14 }
  | { readonly kind: "upstream_http"; readonly status: number }
  | {
      readonly kind: "upstream_protocol"
      readonly reason: TencentProtocolFailure
      readonly ret?: number
    }

const ERROR_MESSAGES = {
  aborted: "request aborted",
  invalid_origin: "untrusted Tencent origin",
  network: "network request failed",
  rate_limited: "upstream rate limited the request",
  reauth_required: "Tencent credentials require reauthentication",
  timeout: "request timed out",
  upstream_http: "upstream HTTP request failed",
  upstream_protocol: "upstream protocol response was rejected",
} as const satisfies Readonly<Record<TencentErrorDetails["kind"], string>>

export class TencentIlinkError extends Error {
  readonly name = "TencentIlinkError"
  readonly details: TencentErrorDetails
  readonly operation: TencentOperation

  constructor(operation: TencentOperation, details: TencentErrorDetails) {
    super(`${operation}: ${ERROR_MESSAGES[details.kind]}`)
    this.operation = operation
    this.details = Object.freeze(details)
  }

  toJSON(): Readonly<{
    name: string
    message: string
    operation: TencentOperation
    details: TencentErrorDetails
  }> {
    return {
      details: this.details,
      message: this.message,
      name: this.name,
      operation: this.operation,
    }
  }
}
