import { describe, expect, it } from "vitest";
import { LoginManager } from "../src/weixin/login.js";
import { WeixinApiClient } from "../src/weixin/api.js";
import type { QrStatusResponse } from "../src/weixin/types.js";
import { makeStore } from "./helpers.js";

async function eventually<T>(read: () => T, matches: (value: T) => boolean): Promise<T> {
  for (let index = 0; index < 100; index++) {
    const value = read();
    if (matches(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not reached");
}

class LoginApiStub extends WeixinApiClient {
  readonly statusCalls: Array<{ baseUrl: string; code?: string }> = [];
  responses: QrStatusResponse[] = [];
  override async createQrCode() { return { qrcode: "qr-id", qrcodeUrl: "https://liteapp.weixin.qq.com/q/test" }; }
  override async getQrStatus(baseUrl: string, _qrcode: string, verifyCode?: string) {
    this.statusCalls.push({ baseUrl, ...(verifyCode ? { code: verifyCode } : {}) });
    return this.responses.shift() ?? { status: "wait" as const };
  }
}

describe("LoginManager", () => {
  it("waits for a verify code, follows the trusted redirect, and persists credentials", async () => {
    const store = makeStore(); const api = new LoginApiStub(); let confirmed = 0;
    api.responses = [
      { status: "need_verifycode" },
      { status: "scaned_but_redirect", redirectHost: "https://sh.ilink.weixin.qq.com" },
      { status: "confirmed", botToken: "new-token", ilinkBotId: "account-new", ilinkUserId: "bot-user", baseUrl: "https://sh.ilink.weixin.qq.com" },
    ];
    const manager = new LoginManager(api, store, () => { confirmed += 1; });
    const created = await manager.create();
    const waiting = await eventually(() => manager.get(created.id), (value) => value?.requiresVerifyCode === true);
    expect(waiting?.qrcodeUrl).toMatch(/^data:image\/png;base64,/);
    manager.verify(created.id, "123456");
    await eventually(() => manager.get(created.id), (value) => value?.status === "confirmed");
    expect(api.statusCalls[1]?.code).toBe("123456");
    expect(api.statusCalls[2]?.baseUrl).toBe("https://sh.ilink.weixin.qq.com");
    expect(store.getCredential()).toMatchObject({ accountId: "account-new", botToken: "new-token", status: "active" });
    expect(confirmed).toBe(1);
    store.close();
  });
});
