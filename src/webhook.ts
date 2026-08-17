import { KeyedSerialExecutor } from "./serial.js";
import { Store } from "./store.js";
import { WeixinApiClient } from "./weixin/api.js";

export class WebhookUnavailableError extends Error {}
export class WebhookPeerUnknownError extends Error {}

export type WebhookSendResult = { status: "sent" | "duplicate"; peerId: string };

export class WebhookService {
  constructor(
    private readonly store: Store,
    private readonly api: WeixinApiClient,
    private readonly serial: KeyedSerialExecutor,
  ) {}

  listPeers(): Array<{ peerId: string; updatedAt: string }> {
    const credential = this.store.getCredential();
    if (!credential || credential.status !== "active") throw new WebhookUnavailableError("微信凭证不可用，请先扫码登录");
    return this.store.listPeers(credential.accountId);
  }

  async send(peerId: string, message: string, idempotencyKey?: string): Promise<WebhookSendResult> {
    const credential = this.store.getCredential();
    if (!credential || credential.status !== "active") throw new WebhookUnavailableError("微信凭证不可用，请先扫码登录");
    return this.serial.run(`${credential.accountId}\0${peerId}`, async () => {
      if (idempotencyKey && this.store.isWebhookProcessed(credential.accountId, idempotencyKey)) {
        return { status: "duplicate", peerId };
      }
      const contextToken = this.store.getPeerContext(credential.accountId, peerId);
      if (!contextToken) throw new WebhookPeerUnknownError("该用户尚未给机器人发送过消息，缺少 context_token");
      await this.api.sendText(credential.baseUrl, credential.botToken, peerId, contextToken, message);
      this.store.saveOutbound({
        accountId: credential.accountId, peerId, text: message, contextToken,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
      return { status: "sent", peerId };
    });
  }
}
