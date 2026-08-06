import type { AxiosAdapter } from "axios"

import {
  canonicalizeTencentBaseUrl,
  canonicalizeTencentRedirectHost,
  canonicalizeTencentResourceUrl,
} from "./origin"
import {
  type FetchQrCodeInput,
  type GetQrStatusInput,
  type GetUpdatesInput,
  type GetUpdatesResponse,
  type NotifyInput,
  type QrCodeResponse,
  type QrStatusResponse,
  type SendMessageInput,
  type SendMessageResult,
  sanitizeBotAgent,
  selectLocalTokens,
  TENCENT_API_TIMEOUT_MS,
  TENCENT_CHANNEL_VERSION,
  TENCENT_ILINK_ORIGIN,
  TENCENT_LONG_POLL_TIMEOUT_MS,
  TENCENT_RESPONSE_SCHEMAS,
} from "./protocol"
import { assertSuccessfulTencentRet, TencentTransport } from "./transport"

export type TencentIlinkAdapterOptions = {
  readonly botAgent?: string
  readonly transport?: AxiosAdapter
}

export class TencentIlinkAdapter {
  private readonly botAgent: string
  private readonly transport: TencentTransport

  constructor(options: TencentIlinkAdapterOptions = {}) {
    this.botAgent = sanitizeBotAgent(options.botAgent)
    this.transport = new TencentTransport(options.transport)
  }

  async fetchQrCode(input: FetchQrCodeInput): Promise<QrCodeResponse> {
    const response = await this.transport.request({
      baseUrl: TENCENT_ILINK_ORIGIN,
      body: { local_token_list: selectLocalTokens(input.localCredentials) },
      method: "post",
      operation: "fetch_qr_code",
      path: "/ilink/bot/get_bot_qrcode?bot_type=3",
      schema: TENCENT_RESPONSE_SCHEMAS.qrCode,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      timeout: TENCENT_API_TIMEOUT_MS,
    })
    return {
      ...response,
      qrcode_img_content: canonicalizeTencentResourceUrl({
        operation: "fetch_qr_code",
        value: response.qrcode_img_content,
      }),
    }
  }

  async getQrStatus(input: GetQrStatusInput): Promise<QrStatusResponse> {
    const query = new URLSearchParams({ qrcode: input.qrcode })
    if (input.verifyCode !== undefined) {
      query.set("verify_code", input.verifyCode)
    }
    const response = await this.transport.request({
      baseUrl: input.baseUrl,
      method: "get",
      operation: "get_qr_status",
      path: `/ilink/bot/get_qrcode_status?${query.toString()}`,
      schema: TENCENT_RESPONSE_SCHEMAS.qrStatus,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      timeout: TENCENT_LONG_POLL_TIMEOUT_MS,
    })
    return {
      ...response,
      ...(response.baseurl === undefined
        ? {}
        : {
            baseurl: canonicalizeTencentBaseUrl({
              operation: "get_qr_status",
              value: response.baseurl,
            }),
          }),
      ...(response.redirect_host === undefined
        ? {}
        : {
            redirect_host: canonicalizeTencentRedirectHost({
              operation: "get_qr_status",
              value: response.redirect_host,
            }),
          }),
    }
  }

  async getUpdates(input: GetUpdatesInput): Promise<GetUpdatesResponse> {
    const response = await this.transport.request({
      baseUrl: input.credentials.baseUrl,
      body: {
        base_info: this.baseInfo(),
        get_updates_buf: input.getUpdatesBuffer,
      },
      method: "post",
      operation: "get_updates",
      path: "/ilink/bot/getupdates",
      schema: TENCENT_RESPONSE_SCHEMAS.getUpdates,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      timeout: TENCENT_LONG_POLL_TIMEOUT_MS,
      token: input.credentials.botToken,
    })
    assertSuccessfulTencentRet("get_updates", response)
    return response
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const response = await this.transport.request({
      baseUrl: input.credentials.baseUrl,
      body: {
        base_info: this.baseInfo(),
        msg: {
          client_id: input.clientId,
          context_token: input.contextToken,
          from_user_id: "",
          item_list: [{ text_item: { text: input.text }, type: 1 }],
          message_state: 2,
          message_type: 2,
          to_user_id: input.recipient,
        },
      },
      method: "post",
      operation: "send_message",
      path: "/ilink/bot/sendmessage",
      schema: TENCENT_RESPONSE_SCHEMAS.ret,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      timeout: TENCENT_API_TIMEOUT_MS,
      token: input.credentials.botToken,
    })
    assertSuccessfulTencentRet("send_message", response)
    return { clientId: input.clientId, messageId: input.clientId }
  }

  async notifyStart(input: NotifyInput): Promise<void> {
    await this.notify("notify_start", "/ilink/bot/msg/notifystart", input)
  }

  async notifyStop(input: NotifyInput): Promise<void> {
    await this.notify("notify_stop", "/ilink/bot/msg/notifystop", input)
  }

  private baseInfo(): Readonly<{ channel_version: "2.4.6"; bot_agent: string }> {
    return { bot_agent: this.botAgent, channel_version: TENCENT_CHANNEL_VERSION }
  }

  private async notify(
    operation: "notify_start" | "notify_stop",
    path: string,
    input: NotifyInput,
  ): Promise<void> {
    const response = await this.transport.request({
      baseUrl: input.credentials.baseUrl,
      body: { base_info: this.baseInfo() },
      method: "post",
      operation,
      path,
      schema: TENCENT_RESPONSE_SCHEMAS.ret,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      timeout: TENCENT_API_TIMEOUT_MS,
      token: input.credentials.botToken,
    })
    assertSuccessfulTencentRet(operation, response)
  }
}

export function createTencentIlinkAdapter(
  options: TencentIlinkAdapterOptions = {},
): TencentIlinkAdapter {
  return new TencentIlinkAdapter(options)
}
