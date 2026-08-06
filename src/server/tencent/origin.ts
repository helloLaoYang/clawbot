import { TencentIlinkError } from "./errors"
import type { TencentOperation } from "./protocol"

type TencentUrlInput = {
  readonly operation: TencentOperation
  readonly value: string
}

function parseTrustedTencentUrl(input: TencentUrlInput): URL {
  let url: URL
  try {
    url = new URL(input.value)
  } catch (error) {
    if (error instanceof TypeError) {
      throw new TencentIlinkError(input.operation, { kind: "invalid_origin" })
    }
    throw error
  }

  const hostname = url.hostname.toLowerCase()
  const isTrustedHostname = hostname === "weixin.qq.com" || hostname.endsWith(".weixin.qq.com")
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    !isTrustedHostname
  ) {
    throw new TencentIlinkError(input.operation, { kind: "invalid_origin" })
  }
  return url
}

export function canonicalizeTencentBaseUrl(input: TencentUrlInput): string {
  const url = parseTrustedTencentUrl(input)
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new TencentIlinkError(input.operation, { kind: "invalid_origin" })
  }
  return url.origin
}

export function canonicalizeTencentResourceUrl(input: TencentUrlInput): string {
  return parseTrustedTencentUrl(input).toString()
}

export function canonicalizeTencentRedirectHost(input: TencentUrlInput): string {
  const origin = canonicalizeTencentBaseUrl({
    operation: input.operation,
    value: `https://${input.value}`,
  })
  return new URL(origin).hostname
}
