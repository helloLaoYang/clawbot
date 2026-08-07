import { Buffer } from "node:buffer"
import { randomBytes } from "node:crypto"

import axios, {
  type AxiosAdapter,
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
  type CreateAxiosDefaults,
} from "axios"
import { ZodError, type ZodType } from "zod"

import { TencentIlinkError } from "./errors"
import { canonicalizeTencentBaseUrl } from "./origin"
import {
  type RetResponse,
  TENCENT_API_TIMEOUT_MS,
  TENCENT_AUTHORIZATION_TYPE,
  TENCENT_BODY_LIMIT_BYTES,
  TENCENT_ILINK_APP_ID,
  TENCENT_ILINK_CLIENT_VERSION,
  type TencentOperation,
} from "./protocol"

type RequestSpec<Response> = {
  readonly operation: TencentOperation
  readonly method: "get" | "post"
  readonly baseUrl: string
  readonly path: string
  readonly schema: ZodType<Response>
  readonly timeout: number
  readonly body?: Readonly<Record<string, unknown>>
  readonly signal?: AbortSignal
  readonly token?: string
}

function createAxiosInstance(adapter: AxiosAdapter | undefined): AxiosInstance {
  const defaults = {
    maxBodyLength: TENCENT_BODY_LIMIT_BYTES,
    maxContentLength: TENCENT_BODY_LIMIT_BYTES,
    maxRedirects: 0,
    responseType: "text",
    timeout: TENCENT_API_TIMEOUT_MS,
    transitional: {
      clarifyTimeoutError: true,
      forcedJSONParsing: false,
      silentJSONParsing: false,
    },
    transformResponse: [(data: unknown) => data],
    validateStatus: () => true,
    ...(adapter === undefined ? {} : { adapter }),
  } satisfies CreateAxiosDefaults<unknown>
  return axios.create(defaults)
}

function createHeaders(method: "get" | "post", token: string | undefined): Record<string, string> {
  const common = {
    "iLink-App-ClientVersion": TENCENT_ILINK_CLIENT_VERSION,
    "iLink-App-Id": TENCENT_ILINK_APP_ID,
  }
  if (method === "get") {
    return common
  }
  const decimalUin = String(randomBytes(4).readUInt32BE(0))
  const postHeaders = {
    ...common,
    "Content-Type": "application/json",
    AuthorizationType: TENCENT_AUTHORIZATION_TYPE,
    "X-WECHAT-UIN": Buffer.from(decimalUin, "ascii").toString("base64"),
  }
  return token === undefined
    ? postHeaders
    : { ...postHeaders, Authorization: `Bearer ${token.trim()}` }
}

export function assertSuccessfulTencentRet(
  operation: TencentOperation,
  response: RetResponse,
): void {
  if (response.errcode !== undefined && response.errcode !== 0) {
    if (response.errcode === -14) {
      throw new TencentIlinkError(operation, { kind: "reauth_required", errcode: -14 })
    }
    throw new TencentIlinkError(operation, {
      kind: "upstream_protocol",
      reason: "nonzero_errcode",
      errcode: response.errcode,
    })
  }
  if (response.ret === 0) {
    return
  }
  if (response.ret === -14) {
    throw new TencentIlinkError(operation, { kind: "reauth_required", ret: -14 })
  }
  if (response.ret === -2) {
    throw new TencentIlinkError(operation, { kind: "rate_limited", ret: -2, source: "protocol" })
  }
  throw new TencentIlinkError(operation, {
    kind: "upstream_protocol",
    reason: "nonzero_ret",
    ret: response.ret,
  })
}

export class TencentTransport {
  private readonly client: AxiosInstance

  constructor(adapter: AxiosAdapter | undefined) {
    this.client = createAxiosInstance(adapter)
  }

  async request<Response>(spec: RequestSpec<Response>): Promise<Response> {
    const baseUrl = canonicalizeTencentBaseUrl({ operation: spec.operation, value: spec.baseUrl })
    const serializedBody = spec.body === undefined ? undefined : JSON.stringify(spec.body)
    if (
      serializedBody !== undefined &&
      Buffer.byteLength(serializedBody, "utf8") > TENCENT_BODY_LIMIT_BYTES
    ) {
      throw new TencentIlinkError(spec.operation, {
        kind: "upstream_protocol",
        reason: "request_too_large",
      })
    }

    const config = {
      headers: createHeaders(spec.method, spec.token),
      maxBodyLength: TENCENT_BODY_LIMIT_BYTES,
      maxContentLength: TENCENT_BODY_LIMIT_BYTES,
      maxRedirects: 0,
      method: spec.method,
      responseType: "text",
      timeout: spec.timeout,
      url: new URL(spec.path, `${baseUrl}/`).toString(),
      ...(serializedBody === undefined ? {} : { data: serializedBody }),
      ...(spec.signal === undefined ? {} : { signal: spec.signal }),
    } satisfies AxiosRequestConfig<string>

    let response: AxiosResponse<unknown, string>
    try {
      response = await this.client.request<unknown, AxiosResponse<unknown, string>, string>(config)
    } catch (error) {
      if (error instanceof TencentIlinkError) {
        throw error
      }
      if (axios.isAxiosError<unknown, string>(error)) {
        if (error.code === AxiosError.ERR_CANCELED) {
          throw new TencentIlinkError(spec.operation, { kind: "aborted" })
        }
        if (error.code === AxiosError.ETIMEDOUT || error.code === AxiosError.ECONNABORTED) {
          throw new TencentIlinkError(spec.operation, { kind: "timeout" })
        }
        if (
          error.code === AxiosError.ERR_BAD_RESPONSE &&
          error.message === `maxContentLength size of ${TENCENT_BODY_LIMIT_BYTES} exceeded`
        ) {
          throw new TencentIlinkError(spec.operation, {
            kind: "upstream_protocol",
            reason: "response_too_large",
          })
        }
      }
      throw new TencentIlinkError(spec.operation, { kind: "network" })
    }

    if (response.status === 429) {
      throw new TencentIlinkError(spec.operation, {
        kind: "rate_limited",
        source: "http",
        status: 429,
      })
    }
    if (response.status < 200 || response.status >= 300) {
      throw new TencentIlinkError(spec.operation, {
        kind: "upstream_http",
        status: response.status,
      })
    }
    if (typeof response.data !== "string") {
      throw new TencentIlinkError(spec.operation, {
        kind: "upstream_protocol",
        reason: "malformed_response",
      })
    }
    if (Buffer.byteLength(response.data, "utf8") > TENCENT_BODY_LIMIT_BYTES) {
      throw new TencentIlinkError(spec.operation, {
        kind: "upstream_protocol",
        reason: "response_too_large",
      })
    }

    try {
      const decoded: unknown = JSON.parse(response.data)
      return spec.schema.parse(decoded)
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof ZodError) {
        throw new TencentIlinkError(spec.operation, {
          kind: "upstream_protocol",
          reason: "malformed_response",
        })
      }
      throw error
    }
  }
}
