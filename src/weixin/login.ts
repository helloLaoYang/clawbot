import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { Store } from "../store.js";
import { WeixinApiClient, trustedUrl } from "./api.js";
import { WEIXIN_DEFAULT_BASE_URL, type QrStatus } from "./types.js";

export type LoginSessionView = {
  id: string;
  status: QrStatus | "starting" | "error";
  qrcodeUrl: string | null;
  expiresAt: string;
  requiresVerifyCode: boolean;
  message: string | null;
};
type InternalSession = LoginSessionView & { qrcode: string; baseUrl: string; verifyCode?: string; stopped: boolean };

export class LoginManager {
  private active: InternalSession | null = null;
  constructor(private readonly api: WeixinApiClient, private readonly store: Store, private readonly onConfirmed: () => void) {}

  async create(): Promise<LoginSessionView> {
    if (this.active) this.active.stopped = true;
    const currentToken = this.store.getCredential()?.botToken;
    const qr = await this.api.createQrCode(WEIXIN_DEFAULT_BASE_URL, currentToken ? [currentToken] : []);
    const session: InternalSession = {
      id: randomUUID(), status: "wait", qrcodeUrl: await QRCode.toDataURL(qr.qrcodeUrl, { width: 320, margin: 2 }), qrcode: qr.qrcode,
      baseUrl: WEIXIN_DEFAULT_BASE_URL, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      requiresVerifyCode: false, message: null, stopped: false,
    };
    this.active = session;
    void this.poll(session);
    return this.view(session);
  }

  get(id: string): LoginSessionView | null {
    return this.active?.id === id ? this.view(this.active) : null;
  }

  verify(id: string, code: string): LoginSessionView | null {
    if (!this.active || this.active.id !== id) return null;
    this.active.verifyCode = code;
    this.active.requiresVerifyCode = false;
    this.active.message = "验证码已提交，等待微信确认";
    return this.view(this.active);
  }

  private async poll(session: InternalSession) {
    while (!session.stopped && Date.now() < Date.parse(session.expiresAt)) {
      try {
        const result = await this.api.getQrStatus(session.baseUrl, session.qrcode, session.verifyCode);
        delete session.verifyCode;
        session.status = result.status;
        session.message = result.message ?? null;
        session.requiresVerifyCode = result.status === "need_verifycode";
        if (result.status === "need_verifycode") {
          while (!session.verifyCode && !session.stopped && Date.now() < Date.parse(session.expiresAt)) {
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          continue;
        }
        if (result.status === "confirmed") {
          if (!result.botToken || !result.ilinkBotId || !result.ilinkUserId) throw new Error("登录确认响应缺少凭证");
          this.store.saveCredential({
            accountId: result.ilinkBotId, botToken: result.botToken,
            baseUrl: result.baseUrl ? trustedUrl(result.baseUrl) : session.baseUrl,
            ilinkUserId: result.ilinkUserId, cursor: "",
          });
          session.stopped = true;
          this.onConfirmed();
          return;
        }
        if (result.status === "binded_redirect") {
          const existing = this.store.getCredential();
          if (!existing) throw new Error("微信返回已绑定，但本地没有可用凭证");
          session.status = "confirmed";
          session.message = "该机器人已连接，无需重复绑定";
          session.stopped = true;
          this.onConfirmed();
          return;
        }
        if (result.status === "scaned_but_redirect") {
          if (!result.redirectHost) throw new Error("微信要求重定向但未返回可信地址");
          session.baseUrl = result.redirectHost;
          session.message = "已切换到微信指定线路，继续等待确认";
        }
        if (result.status === "expired" || result.status === "verify_code_blocked") {
          session.stopped = true;
          return;
        }
      } catch (error) {
        session.status = "error";
        session.message = error instanceof Error ? error.message : "扫码状态查询失败";
        session.stopped = true;
      }
    }
    if (!session.stopped) session.status = "expired";
  }

  private view(session: InternalSession): LoginSessionView {
    return {
      id: session.id, status: session.status, qrcodeUrl: session.qrcodeUrl,
      expiresAt: session.expiresAt, requiresVerifyCode: session.requiresVerifyCode,
      message: session.message,
    };
  }
}
