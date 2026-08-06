import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

import type { BotAuthStatus } from "../contracts"
import type { BotId, BotPublicId, ContextId, EpochMilliseconds } from "../ids"
import { encryptedEnvelopeCheck, sha256Check, uuidV4Check } from "./checks"

export const bots = sqliteTable(
  "bots",
  {
    id: text("id").$type<BotId>().primaryKey(),
    publicId: text("public_id").$type<BotPublicId>().notNull(),
    accountFingerprint: text("account_fingerprint").notNull(),
    ilinkBotIdLookupHash: text("ilink_bot_id_lookup_hash").notNull(),
    boundUserFingerprint: text("bound_user_fingerprint"),
    ilinkBotIdEncrypted: text("ilink_bot_id_encrypted").notNull(),
    ilinkUserIdEncrypted: text("ilink_user_id_encrypted").notNull(),
    remark: text("remark").notNull().default(""),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    authStatus: text("auth_status").$type<BotAuthStatus>().notNull().default("active"),
    maxSendsPerMinute: integer("max_sends_per_minute").notNull(),
    createdAt: integer("created_at").$type<EpochMilliseconds>().notNull(),
    updatedAt: integer("updated_at").$type<EpochMilliseconds>().notNull(),
  },
  (table) => [
    uuidV4Check("bots_id_uuid_v4", table.id),
    uuidV4Check("bots_public_id_uuid_v4", table.publicId),
    uniqueIndex("bots_public_id_unique").on(table.publicId),
    uniqueIndex("bots_upstream_lookup_unique").on(table.ilinkBotIdLookupHash),
    sha256Check("bots_upstream_lookup_sha256", table.ilinkBotIdLookupHash),
    check(
      "bots_account_fingerprint_format",
      sql`length(${table.accountFingerprint}) = 13
        AND substr(${table.accountFingerprint}, 1, 5) = 'acct_'
        AND substr(${table.accountFingerprint}, 6) NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "bots_bound_user_fingerprint_format",
      sql`${table.boundUserFingerprint} IS NULL OR (
        length(${table.boundUserFingerprint}) = 13
        AND substr(${table.boundUserFingerprint}, 1, 5) = 'user_'
        AND substr(${table.boundUserFingerprint}, 6) NOT GLOB '*[^0-9a-f]*'
      )`,
    ),
    encryptedEnvelopeCheck("bots_ilink_bot_id_encrypted", table.ilinkBotIdEncrypted),
    encryptedEnvelopeCheck("bots_ilink_user_id_encrypted", table.ilinkUserIdEncrypted),
    check("bots_remark_length", sql`length(${table.remark}) <= 200`),
    check("bots_enabled_boolean", sql`${table.enabled} IN (0, 1)`),
    check("bots_auth_status_enum", sql`${table.authStatus} IN ('active', 'reauth_required')`),
    check("bots_max_sends_per_minute_range", sql`${table.maxSendsPerMinute} BETWEEN 1 AND 600`),
    check(
      "bots_timestamps_nonnegative",
      sql`${table.createdAt} >= 0 AND ${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
)

export const botSecrets = sqliteTable(
  "bot_secrets",
  {
    botId: text("bot_id")
      .$type<BotId>()
      .primaryKey()
      .references(() => bots.id, { onDelete: "cascade" }),
    botTokenEncrypted: text("bot_token_encrypted").notNull(),
    baseUrl: text("base_url").notNull(),
    webhookBearerHash: text("webhook_bearer_hash").notNull(),
    webhookBearerLastFour: text("webhook_bearer_last_four").notNull(),
    createdAt: integer("created_at").$type<EpochMilliseconds>().notNull(),
    updatedAt: integer("updated_at").$type<EpochMilliseconds>().notNull(),
  },
  (table) => [
    encryptedEnvelopeCheck("bot_secrets_token_encrypted", table.botTokenEncrypted),
    sha256Check("bot_secrets_bearer_hash_sha256", table.webhookBearerHash),
    check("bot_secrets_bearer_last_four", sql`length(${table.webhookBearerLastFour}) = 4`),
    check(
      "bot_secrets_timestamps_nonnegative",
      sql`${table.createdAt} >= 0 AND ${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
)

export const conversationContexts = sqliteTable(
  "conversation_contexts",
  {
    id: text("id").$type<ContextId>().primaryKey(),
    botId: text("bot_id")
      .$type<BotId>()
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    userIdEncrypted: text("user_id_encrypted").notNull(),
    userLookupHash: text("user_lookup_hash").notNull(),
    userFingerprint: text("user_fingerprint").notNull(),
    contextTokenEncrypted: text("context_token_encrypted").notNull(),
    createdAt: integer("created_at").$type<EpochMilliseconds>().notNull(),
    updatedAt: integer("updated_at").$type<EpochMilliseconds>().notNull(),
  },
  (table) => [
    uuidV4Check("conversation_contexts_id_uuid_v4", table.id),
    uniqueIndex("conversation_contexts_bot_lookup_unique").on(table.botId, table.userLookupHash),
    index("conversation_contexts_bot_updated_idx").on(table.botId, table.updatedAt),
    encryptedEnvelopeCheck("conversation_contexts_user_id_encrypted", table.userIdEncrypted),
    encryptedEnvelopeCheck(
      "conversation_contexts_context_token_encrypted",
      table.contextTokenEncrypted,
    ),
    sha256Check("conversation_contexts_user_lookup_sha256", table.userLookupHash),
    check(
      "conversation_contexts_user_fingerprint_format",
      sql`length(${table.userFingerprint}) = 13
        AND substr(${table.userFingerprint}, 1, 5) = 'user_'
        AND substr(${table.userFingerprint}, 6) NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "conversation_contexts_timestamps_nonnegative",
      sql`${table.createdAt} >= 0 AND ${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
)

export const inboundState = sqliteTable(
  "inbound_state",
  {
    botId: text("bot_id")
      .$type<BotId>()
      .primaryKey()
      .references(() => bots.id, { onDelete: "cascade" }),
    cursorEncrypted: text("cursor_encrypted"),
    lastPolledAt: integer("last_polled_at").$type<EpochMilliseconds>(),
    updatedAt: integer("updated_at").$type<EpochMilliseconds>().notNull(),
  },
  (table) => [
    check(
      "inbound_state_cursor_encrypted",
      sql`${table.cursorEncrypted} IS NULL OR ${table.cursorEncrypted} LIKE 'v1.%'`,
    ),
    check(
      "inbound_state_timestamps_nonnegative",
      sql`${table.lastPolledAt} IS NULL OR ${table.lastPolledAt} >= 0`,
    ),
    check("inbound_state_updated_nonnegative", sql`${table.updatedAt} >= 0`),
  ],
)

export const rateState = sqliteTable(
  "rate_state",
  {
    botId: text("bot_id")
      .$type<BotId>()
      .primaryKey()
      .references(() => bots.id, { onDelete: "cascade" }),
    lastAttemptAt: integer("last_attempt_at").$type<EpochMilliseconds>(),
    nextEligibleAt: integer("next_eligible_at")
      .$type<EpochMilliseconds>()
      .notNull()
      .default(sql`0`),
    cooldownUntil: integer("cooldown_until").$type<EpochMilliseconds>().notNull().default(sql`0`),
    consecutiveRateLimits: integer("consecutive_rate_limits").notNull().default(0),
    updatedAt: integer("updated_at").$type<EpochMilliseconds>().notNull(),
  },
  (table) => [
    check(
      "rate_state_nonnegative",
      sql`(${table.lastAttemptAt} IS NULL OR ${table.lastAttemptAt} >= 0)
        AND ${table.nextEligibleAt} >= 0
        AND ${table.cooldownUntil} >= 0
        AND ${table.consecutiveRateLimits} >= 0
        AND ${table.updatedAt} >= 0`,
    ),
  ],
)

export const serviceLease = sqliteTable(
  "service_lease",
  {
    name: text("name").$type<"primary">().primaryKey(),
    ownerId: text("owner_id").notNull(),
    fencingToken: integer("fencing_token").notNull(),
    expiresAt: integer("expires_at").$type<EpochMilliseconds>().notNull(),
    updatedAt: integer("updated_at").$type<EpochMilliseconds>().notNull(),
  },
  (table) => [
    check("service_lease_singleton", sql`${table.name} = 'primary'`),
    uuidV4Check("service_lease_owner_uuid_v4", table.ownerId),
    check("service_lease_fencing_positive", sql`${table.fencingToken} >= 1`),
    check(
      "service_lease_timestamps_nonnegative",
      sql`${table.expiresAt} >= 0 AND ${table.updatedAt} >= 0`,
    ),
  ],
)

export const adminLoginState = sqliteTable(
  "admin_login_state",
  {
    id: integer("id").primaryKey(),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    windowStartedAt: integer("window_started_at").$type<EpochMilliseconds>(),
    lockedUntil: integer("locked_until").$type<EpochMilliseconds>(),
    updatedAt: integer("updated_at").$type<EpochMilliseconds>().notNull().default(sql`0`),
  },
  (table) => [
    check("admin_login_state_singleton", sql`${table.id} = 1`),
    check("admin_login_state_failures_nonnegative", sql`${table.failedAttempts} >= 0`),
    check(
      "admin_login_state_timestamps_nonnegative",
      sql`(${table.windowStartedAt} IS NULL OR ${table.windowStartedAt} >= 0)
        AND (${table.lockedUntil} IS NULL OR ${table.lockedUntil} >= 0)
        AND ${table.updatedAt} >= 0`,
    ),
  ],
)

export const encryptionSentinel = sqliteTable(
  "encryption_sentinel",
  {
    id: integer("id").primaryKey(),
    ciphertext: text("ciphertext").notNull(),
    createdAt: integer("created_at").$type<EpochMilliseconds>().notNull(),
  },
  (table) => [
    check("encryption_sentinel_singleton", sql`${table.id} = 1`),
    encryptedEnvelopeCheck("encryption_sentinel_envelope", table.ciphertext),
    check("encryption_sentinel_created_nonnegative", sql`${table.createdAt} >= 0`),
  ],
)
