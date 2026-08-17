import { randomBytes, randomUUID } from "node:crypto";
import { WEIXIN_DEFAULT_BASE_URL, type QrCodeResponse, type QrStatusResponse, type UpdatesResponse } from "./types.js";

const baseInfo = { channel_version: "2.4.6", bot_agent: "Clawbot/0.1.0" };

export class WeixinAuthInvalidError extends Error {}
export class WeixinApiError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

function trustedUrl(value: string): string {
  const url = new URL(value.startsWith("http") ? value : `https://${value}`);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port || !(host === "weixin.qq.com" || host.endsWith(".weixin.qq.com"))) {
    throw new WeixinApiError("Untrusted Weixin endpoint");
  }
  return url.origin;
}

function headers(token?: string): Record<string, string> {
  const result: Record<string, string> = {
    "Content-Type": "application/json",
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": "132102",
    "X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE())).toString("base64"),
    "User-Agent": "Clawbot/0.1.0",
  };
  if (token) {
    result.AuthorizationType = "ilink_bot_token";
    result.Authorization = `Bearer ${token}`;
  }
  return result;
}

async function jsonRequest<T>(url: string, init: RequestInit, timeoutMs = 40_000): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (response.status === 401) throw new WeixinAuthInvalidError("Weixin credential expired");
  if (!response.ok) throw new WeixinApiError(`Weixin HTTP ${response.status}`, response.status);
  const errcode = Number(body.errcode ?? 0);
  const code = errcode !== 0 ? errcode : Number(body.ret ?? 0);
  if (code === -14) throw new WeixinAuthInvalidError("Weixin credential expired");
  if (code !== 0) throw new WeixinApiError(String(body.errmsg ?? `Weixin error ${code}`));
  return body as T;
}

export class WeixinApiClient {
  async createQrCode(baseUrl = WEIXIN_DEFAULT_BASE_URL, localTokens: string[] = []): Promise<QrCodeResponse> {
    const origin = trustedUrl(baseUrl);
    const body = await jsonRequest<Record<string, unknown>>(`${origin}/ilink/bot/get_bot_qrcode?bot_type=3`, {
      method: "POST", headers: headers(), body: JSON.stringify({ local_token_list: localTokens }),
    });
    const qrcode = String(body.qrcode ?? "");
    const qrcodeUrl = String(body.qrcode_url ?? body.qrcode_img_content ?? qrcode);
    if (!qrcode || !qrcodeUrl) throw new WeixinApiError("Weixin did not return a QR code");
    return { qrcode, qrcodeUrl };
  }

  async getQrStatus(baseUrl: string, qrcode: string, verifyCode?: string): Promise<QrStatusResponse> {
    const url = new URL("/ilink/bot/get_qrcode_status", trustedUrl(baseUrl));
    url.searchParams.set("qrcode", qrcode);
    if (verifyCode) url.searchParams.set("verify_code", verifyCode);
    const body = await jsonRequest<Record<string, unknown>>(url.toString(), { method: "GET", headers: headers() }, 40_000);
    const data = (typeof body.data === "object" && body.data ? body.data : body) as Record<string, unknown>;
    return {
      status: String(data.status ?? "wait") as QrStatusResponse["status"],
      ...(data.bot_token ? { botToken: String(data.bot_token) } : {}),
      ...(data.ilink_bot_id ? { ilinkBotId: String(data.ilink_bot_id) } : {}),
      ...(data.ilink_user_id ? { ilinkUserId: String(data.ilink_user_id) } : {}),
      ...(data.baseurl ? { baseUrl: trustedUrl(String(data.baseurl)) } : {}),
      ...(data.redirect_host ? { redirectHost: trustedUrl(String(data.redirect_host)) } : {}),
      ...(data.message ? { message: String(data.message) } : {}),
    };
  }

  async getUpdates(baseUrl: string, token: string, cursor: string): Promise<UpdatesResponse> {
    return jsonRequest<UpdatesResponse>(`${trustedUrl(baseUrl)}/ilink/bot/getupdates`, {
      method: "POST", headers: headers(token), body: JSON.stringify({ get_updates_buf: cursor, base_info: baseInfo }),
    }, 45_000);
  }

  async sendText(baseUrl: string, token: string, toUserId: string, contextToken: string, text: string): Promise<void> {
    await jsonRequest(`${trustedUrl(baseUrl)}/ilink/bot/sendmessage`, {
      method: "POST", headers: headers(token),
      body: JSON.stringify({
        msg: {
          from_user_id: "", to_user_id: toUserId, client_id: randomUUID(), context_token: contextToken,
          message_type: 2, message_state: 2,
          item_list: [{ type: 1, text_item: { text } }],
        },
        base_info: baseInfo,
      }),
    });
  }

  async setTyping(baseUrl: string, token: string, ilinkUserId: string, contextToken: string, typing: boolean): Promise<void> {
    try {
      const config = await jsonRequest<Record<string, unknown>>(`${trustedUrl(baseUrl)}/ilink/bot/getconfig`, {
        method: "POST", headers: headers(token), body: JSON.stringify({ ilink_user_id: ilinkUserId, context_token: contextToken, base_info: baseInfo }),
      });
      const ticket = String(config.typing_ticket ?? "");
      if (!ticket) return;
      await jsonRequest(`${trustedUrl(baseUrl)}/ilink/bot/sendtyping`, {
        method: "POST", headers: headers(token), body: JSON.stringify({ ilink_user_id: ilinkUserId, typing_ticket: ticket, status: typing ? 1 : 2, base_info: baseInfo }),
      });
    } catch { /* typing is best effort */ }
  }

  async notify(baseUrl: string, token: string, starting: boolean): Promise<void> {
    await jsonRequest(`${trustedUrl(baseUrl)}/ilink/bot/msg/${starting ? "notifystart" : "notifystop"}`, {
      method: "POST", headers: headers(token), body: JSON.stringify({ base_info: baseInfo }),
    });
  }
}

export { trustedUrl };
