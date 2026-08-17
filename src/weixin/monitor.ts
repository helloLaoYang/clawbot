import { AgentService } from "../agent.js";
import { Store } from "../store.js";
import { WeixinApiClient, WeixinAuthInvalidError } from "./api.js";

export type MonitorStatus = { running: boolean; healthy: boolean; lastSuccessAt: string | null; lastError: string | null };

export class WeixinMonitor {
  private generation = 0;
  private status: MonitorStatus = { running: false, healthy: false, lastSuccessAt: null, lastError: null };
  constructor(private readonly store: Store, private readonly api: WeixinApiClient, private readonly agent: AgentService) {}

  start() {
    const credential = this.store.getCredential();
    if (!credential || credential.status !== "active") return;
    const generation = ++this.generation;
    this.status = { running: true, healthy: false, lastSuccessAt: null, lastError: null };
    void this.api.notify(credential.baseUrl, credential.botToken, true).catch(() => undefined);
    void this.loop(generation);
  }

  stop() {
    const credential = this.store.getCredential();
    if (credential?.status === "active") void this.api.notify(credential.baseUrl, credential.botToken, false).catch(() => undefined);
    this.generation += 1; this.status.running = false; this.status.healthy = false;
  }
  getStatus(): MonitorStatus { return { ...this.status }; }

  private async loop(generation: number) {
    while (generation === this.generation) {
      const credential = this.store.getCredential();
      if (!credential || credential.status !== "active") break;
      try {
        const updates = await this.api.getUpdates(credential.baseUrl, credential.botToken, credential.cursor);
        await Promise.all((updates.msgs ?? []).map((message) => this.agent.handle(credential.accountId, message)));
        if (updates.get_updates_buf !== undefined) this.store.updateCursor(credential.accountId, updates.get_updates_buf);
        this.status = { running: true, healthy: true, lastSuccessAt: new Date().toISOString(), lastError: null };
      } catch (error) {
        if (error instanceof WeixinAuthInvalidError) {
          this.store.invalidateCredential(credential.accountId);
          this.status = { running: false, healthy: false, lastSuccessAt: this.status.lastSuccessAt, lastError: "微信凭证已失效，请重新扫码" };
          return;
        }
        this.status.healthy = false;
        this.status.lastError = error instanceof Error ? error.message : "微信轮询失败";
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    if (generation === this.generation) this.status.running = false;
  }
}
