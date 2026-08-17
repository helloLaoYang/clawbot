import { mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { SecretBox } from "./crypto.js";

export type MessageRole = "user" | "assistant";
export type StoredMessage = {
  id: number;
  role: MessageRole;
  text: string;
  messageType: "text" | "image";
  sourceMessageId: string | null;
  createdAt: string;
};
export type Conversation = {
  accountId: string;
  peerId: string;
  summary: string;
  summaryThroughMessageId: number | null;
  lastInputTokens: number;
  updatedAt: string;
};
export type GlobalSettings = {
  personalization: string;
  persona: string;
  updatedAt: string | null;
};
export type WeixinCredential = {
  accountId: string;
  botToken: string;
  baseUrl: string;
  ilinkUserId: string;
  cursor: string;
  status: "active" | "invalid";
  updatedAt: string;
};

type Row = Record<string, SQLInputValue>;
const now = () => new Date().toISOString();

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string, private readonly secrets: SecretBox) {
    const absolute = path === ":memory:" ? path : resolve(path);
    if (path !== ":memory:") mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(absolute);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
    if (path !== ":memory:") try { chmodSync(absolute, 0o600); } catch { /* best effort */ }
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        account_id TEXT PRIMARY KEY,
        bot_token_encrypted TEXT NOT NULL,
        base_url TEXT NOT NULL,
        ilink_user_id TEXT NOT NULL,
        cursor_encrypted TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','invalid')),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        account_id TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        summary_through_message_id INTEGER,
        last_input_tokens INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, peer_id)
      );
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user','assistant')),
        text TEXT NOT NULL,
        message_type TEXT NOT NULL CHECK (message_type IN ('text','image')),
        source_message_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (account_id, peer_id) REFERENCES conversations(account_id, peer_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON conversation_messages(account_id, peer_id, id);
      CREATE TABLE IF NOT EXISTS peer_contexts (
        account_id TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        context_token_encrypted TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, peer_id)
      );
      CREATE TABLE IF NOT EXISTS processed_messages (
        account_id TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        PRIMARY KEY (account_id, source_message_id)
      );
      CREATE TABLE IF NOT EXISTS global_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        personalization TEXT NOT NULL DEFAULT '',
        persona TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS command_confirmations (
        account_id TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        command TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (account_id, peer_id, command)
      );
    `);
  }

  ping(): boolean {
    return this.db.prepare("SELECT 1 AS ok").get() !== undefined;
  }

  close() { this.db.close(); }

  saveCredential(value: Omit<WeixinCredential, "updatedAt" | "status">) {
    const updatedAt = now();
    this.transaction(() => {
      this.db.prepare("DELETE FROM accounts WHERE account_id<>?").run(value.accountId);
      this.db.prepare(`INSERT INTO accounts
        (account_id,bot_token_encrypted,base_url,ilink_user_id,cursor_encrypted,status,updated_at)
        VALUES (?,?,?,?,?, 'active', ?)
        ON CONFLICT(account_id) DO UPDATE SET bot_token_encrypted=excluded.bot_token_encrypted,
        base_url=excluded.base_url,ilink_user_id=excluded.ilink_user_id,cursor_encrypted=excluded.cursor_encrypted,
        status='active',updated_at=excluded.updated_at`).run(
          value.accountId,
          this.secrets.encrypt(value.botToken, `accounts:${value.accountId}:bot_token`),
          value.baseUrl,
          value.ilinkUserId,
          this.secrets.encrypt(value.cursor, `accounts:${value.accountId}:cursor`),
          updatedAt,
        );
    });
  }

  getCredential(): WeixinCredential | null {
    const row = this.db.prepare("SELECT * FROM accounts ORDER BY updated_at DESC LIMIT 1").get() as Row | undefined;
    if (!row) return null;
    const accountId = String(row.account_id);
    return {
      accountId,
      botToken: this.secrets.decrypt(String(row.bot_token_encrypted), `accounts:${accountId}:bot_token`),
      baseUrl: String(row.base_url),
      ilinkUserId: String(row.ilink_user_id),
      cursor: this.secrets.decrypt(String(row.cursor_encrypted), `accounts:${accountId}:cursor`),
      status: String(row.status) as WeixinCredential["status"],
      updatedAt: String(row.updated_at),
    };
  }

  updateCursor(accountId: string, cursor: string) {
    this.db.prepare("UPDATE accounts SET cursor_encrypted=?,updated_at=? WHERE account_id=?").run(
      this.secrets.encrypt(cursor, `accounts:${accountId}:cursor`), now(), accountId,
    );
  }

  invalidateCredential(accountId: string) {
    this.db.prepare("UPDATE accounts SET status='invalid',updated_at=? WHERE account_id=?").run(now(), accountId);
  }

  getConversation(accountId: string, peerId: string): Conversation {
    const row = this.db.prepare("SELECT * FROM conversations WHERE account_id=? AND peer_id=?").get(accountId, peerId) as Row | undefined;
    if (!row) return { accountId, peerId, summary: "", summaryThroughMessageId: null, lastInputTokens: 0, updatedAt: now() };
    return {
      accountId, peerId, summary: String(row.summary),
      summaryThroughMessageId: row.summary_through_message_id === null ? null : Number(row.summary_through_message_id),
      lastInputTokens: Number(row.last_input_tokens), updatedAt: String(row.updated_at),
    };
  }

  listMessagesAfter(accountId: string, peerId: string, afterId: number | null): StoredMessage[] {
    const rows = (afterId === null
      ? this.db.prepare("SELECT * FROM conversation_messages WHERE account_id=? AND peer_id=? ORDER BY id").all(accountId, peerId)
      : this.db.prepare("SELECT * FROM conversation_messages WHERE account_id=? AND peer_id=? AND id>? ORDER BY id").all(accountId, peerId, afterId)) as Row[];
    return rows.map((row) => ({
      id: Number(row.id), role: String(row.role) as MessageRole, text: String(row.text),
      messageType: String(row.message_type) as StoredMessage["messageType"],
      sourceMessageId: row.source_message_id === null ? null : String(row.source_message_id),
      createdAt: String(row.created_at),
    }));
  }

  updateSummary(accountId: string, peerId: string, summary: string, throughId: number) {
    this.transaction(() => {
      this.ensureConversation(accountId, peerId);
      this.db.prepare(`UPDATE conversations SET summary=?,summary_through_message_id=?,updated_at=?
        WHERE account_id=? AND peer_id=?`).run(summary, throughId, now(), accountId, peerId);
    });
  }

  getGlobalSettings(): GlobalSettings {
    const row = this.db.prepare("SELECT personalization,persona,updated_at FROM global_settings WHERE id=1").get() as Row | undefined;
    if (!row) return { personalization: "", persona: "", updatedAt: null };
    return {
      personalization: String(row.personalization),
      persona: String(row.persona),
      updatedAt: String(row.updated_at),
    };
  }

  updateGlobalSettings(settings: Pick<GlobalSettings, "personalization" | "persona">): GlobalSettings {
    const updatedAt = now();
    this.db.prepare(`INSERT INTO global_settings(id,personalization,persona,updated_at) VALUES (1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET personalization=excluded.personalization,persona=excluded.persona,updated_at=excluded.updated_at`).run(
        settings.personalization, settings.persona, updatedAt,
      );
    return { ...settings, updatedAt };
  }

  saveTurn(args: { accountId: string; peerId: string; sourceMessageId: string; userText: string; userType: "text" | "image"; assistantText: string; inputTokens: number; contextToken: string }) {
    this.transaction(() => {
      this.ensureConversation(args.accountId, args.peerId);
      const timestamp = now();
      this.db.prepare(`INSERT INTO conversation_messages
        (account_id,peer_id,role,text,message_type,source_message_id,created_at) VALUES (?,?,?,?,?,?,?)`).run(
        args.accountId, args.peerId, "user", args.userText, args.userType, args.sourceMessageId, timestamp,
      );
      this.db.prepare(`INSERT INTO conversation_messages
        (account_id,peer_id,role,text,message_type,source_message_id,created_at) VALUES (?,?,?,?,?,NULL,?)`).run(
        args.accountId, args.peerId, "assistant", args.assistantText, "text", timestamp,
      );
      this.db.prepare("UPDATE conversations SET last_input_tokens=?,updated_at=? WHERE account_id=? AND peer_id=?").run(
        args.inputTokens, timestamp, args.accountId, args.peerId,
      );
      this.savePeerContext(args.accountId, args.peerId, args.contextToken, timestamp);
      this.markProcessed(args.accountId, args.sourceMessageId, timestamp);
    });
  }

  reset(accountId: string, peerId: string, sourceMessageId: string, contextToken: string) {
    this.transaction(() => {
      this.db.prepare("DELETE FROM conversations WHERE account_id=? AND peer_id=?").run(accountId, peerId);
      this.db.prepare("DELETE FROM peer_contexts WHERE account_id=? AND peer_id=?").run(accountId, peerId);
      this.db.prepare("DELETE FROM command_confirmations WHERE account_id=? AND peer_id=?").run(accountId, peerId);
      const timestamp = now();
      this.savePeerContext(accountId, peerId, contextToken, timestamp);
      this.markProcessed(accountId, sourceMessageId, timestamp);
    });
  }

  hasCommandConfirmation(accountId: string, peerId: string, command: string): boolean {
    const timestamp = now();
    this.db.prepare("DELETE FROM command_confirmations WHERE expires_at<=?").run(timestamp);
    return this.db.prepare(`SELECT 1 FROM command_confirmations
      WHERE account_id=? AND peer_id=? AND command=?`).get(accountId, peerId, command) !== undefined;
  }

  setCommandConfirmation(args: { accountId: string; peerId: string; command: string; sourceMessageId: string; contextToken: string; ttlMs: number }) {
    this.transaction(() => {
      const timestamp = now();
      const expiresAt = new Date(Date.now() + args.ttlMs).toISOString();
      this.db.prepare(`INSERT INTO command_confirmations(account_id,peer_id,command,expires_at) VALUES (?,?,?,?)
        ON CONFLICT(account_id,peer_id,command) DO UPDATE SET expires_at=excluded.expires_at`).run(
          args.accountId, args.peerId, args.command, expiresAt,
        );
      this.savePeerContext(args.accountId, args.peerId, args.contextToken, timestamp);
      this.markProcessed(args.accountId, args.sourceMessageId, timestamp);
    });
  }

  isProcessed(accountId: string, sourceMessageId: string): boolean {
    return this.db.prepare("SELECT 1 FROM processed_messages WHERE account_id=? AND source_message_id=?").get(accountId, sourceMessageId) !== undefined;
  }

  markMessageProcessed(accountId: string, sourceMessageId: string, contextToken?: string, peerId?: string) {
    this.transaction(() => {
      const timestamp = now();
      this.markProcessed(accountId, sourceMessageId, timestamp);
      if (contextToken && peerId) this.savePeerContext(accountId, peerId, contextToken, timestamp);
    });
  }

  isWebhookProcessed(accountId: string, idempotencyKey: string): boolean {
    return this.isProcessed(accountId, `webhook:${idempotencyKey}`);
  }

  saveOutbound(args: { accountId: string; peerId: string; text: string; contextToken: string; idempotencyKey?: string }) {
    this.transaction(() => {
      this.ensureConversation(args.accountId, args.peerId);
      const timestamp = now();
      this.db.prepare(`INSERT INTO conversation_messages
        (account_id,peer_id,role,text,message_type,source_message_id,created_at) VALUES (?,?,?,?,?,NULL,?)`).run(
        args.accountId, args.peerId, "assistant", args.text, "text", timestamp,
      );
      this.db.prepare("UPDATE conversations SET updated_at=? WHERE account_id=? AND peer_id=?").run(timestamp, args.accountId, args.peerId);
      this.savePeerContext(args.accountId, args.peerId, args.contextToken, timestamp);
      if (args.idempotencyKey) this.markProcessed(args.accountId, `webhook:${args.idempotencyKey}`, timestamp);
    });
  }

  getPeerContext(accountId: string, peerId: string): string | null {
    const row = this.db.prepare("SELECT context_token_encrypted FROM peer_contexts WHERE account_id=? AND peer_id=?").get(accountId, peerId) as Row | undefined;
    return row ? this.secrets.decrypt(String(row.context_token_encrypted), `peer_contexts:${accountId}:${peerId}`) : null;
  }

  listPeers(accountId: string): Array<{ peerId: string; updatedAt: string }> {
    const rows = this.db.prepare("SELECT peer_id,updated_at FROM peer_contexts WHERE account_id=? ORDER BY updated_at DESC").all(accountId) as Row[];
    return rows.map((row) => ({ peerId: String(row.peer_id), updatedAt: String(row.updated_at) }));
  }

  private ensureConversation(accountId: string, peerId: string) {
    this.db.prepare(`INSERT INTO conversations(account_id,peer_id,updated_at) VALUES (?,?,?)
      ON CONFLICT(account_id,peer_id) DO NOTHING`).run(accountId, peerId, now());
  }

  private markProcessed(accountId: string, sourceMessageId: string, timestamp: string) {
    this.db.prepare("INSERT OR IGNORE INTO processed_messages(account_id,source_message_id,processed_at) VALUES (?,?,?)").run(accountId, sourceMessageId, timestamp);
  }

  private savePeerContext(accountId: string, peerId: string, token: string, timestamp: string) {
    this.db.prepare(`INSERT INTO peer_contexts(account_id,peer_id,context_token_encrypted,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(account_id,peer_id) DO UPDATE SET context_token_encrypted=excluded.context_token_encrypted,updated_at=excluded.updated_at`).run(
        accountId, peerId, this.secrets.encrypt(token, `peer_contexts:${accountId}:${peerId}`), timestamp,
      );
  }

  private transaction<T>(callback: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = callback(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
