CREATE TABLE `admin_login_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`window_started_at` integer,
	`locked_until` integer,
	`updated_at` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "admin_login_state_singleton" CHECK("admin_login_state"."id" = 1),
	CONSTRAINT "admin_login_state_failures_nonnegative" CHECK("admin_login_state"."failed_attempts" >= 0),
	CONSTRAINT "admin_login_state_timestamps_nonnegative" CHECK(("admin_login_state"."window_started_at" IS NULL OR "admin_login_state"."window_started_at" >= 0)
        AND ("admin_login_state"."locked_until" IS NULL OR "admin_login_state"."locked_until" >= 0)
        AND "admin_login_state"."updated_at" >= 0)
);
--> statement-breakpoint
CREATE TABLE `attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`classification` text NOT NULL,
	`http_status` integer,
	`tencent_ret` integer,
	`duration_ms` integer,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "attempts_id_uuid_v4" CHECK(length("attempts"."id") = 36
      AND substr("attempts"."id", 9, 1) = '-'
      AND substr("attempts"."id", 14, 1) = '-'
      AND substr("attempts"."id", 15, 1) = '4'
      AND substr("attempts"."id", 19, 1) = '-'
      AND substr("attempts"."id", 20, 1) IN ('8', '9', 'a', 'b')
      AND substr("attempts"."id", 24, 1) = '-'
      AND "attempts"."id" = lower("attempts"."id")
      AND length(replace("attempts"."id", '-', '')) = 32
      AND "attempts"."id" NOT GLOB '*[^0-9a-f-]*'),
	CONSTRAINT "attempts_attempt_positive" CHECK("attempts"."attempt" >= 1),
	CONSTRAINT "attempts_classification_enum" CHECK("attempts"."classification" IN (
        'in_flight', 'success', 'network', 'timeout', 'rate_limited',
        'upstream_http', 'upstream_protocol', 'reauth_required', 'abandoned'
      )),
	CONSTRAINT "attempts_completion_consistent" CHECK(("attempts"."classification" = 'in_flight' AND "attempts"."completed_at" IS NULL)
        OR ("attempts"."classification" <> 'in_flight' AND "attempts"."completed_at" IS NOT NULL)),
	CONSTRAINT "attempts_duration_nonnegative" CHECK("attempts"."duration_ms" IS NULL OR "attempts"."duration_ms" >= 0),
	CONSTRAINT "attempts_timestamps_nonnegative" CHECK("attempts"."started_at" >= 0
        AND ("attempts"."completed_at" IS NULL OR "attempts"."completed_at" >= "attempts"."started_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_job_attempt_unique` ON `attempts` (`job_id`,`attempt`);--> statement-breakpoint
CREATE INDEX `attempts_job_started_idx` ON `attempts` (`job_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `batches` (
	`id` text PRIMARY KEY NOT NULL,
	`invocation_id` text NOT NULL,
	`recipient_encrypted` text NOT NULL,
	`recipient_lookup_hash` text NOT NULL,
	`user_fingerprint` text NOT NULL,
	`text_encrypted` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`invocation_id`) REFERENCES `invocations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "batches_id_uuid_v4" CHECK(length("batches"."id") = 36
      AND substr("batches"."id", 9, 1) = '-'
      AND substr("batches"."id", 14, 1) = '-'
      AND substr("batches"."id", 15, 1) = '4'
      AND substr("batches"."id", 19, 1) = '-'
      AND substr("batches"."id", 20, 1) IN ('8', '9', 'a', 'b')
      AND substr("batches"."id", 24, 1) = '-'
      AND "batches"."id" = lower("batches"."id")
      AND length(replace("batches"."id", '-', '')) = 32
      AND "batches"."id" NOT GLOB '*[^0-9a-f-]*'),
	CONSTRAINT "batches_recipient_encrypted" CHECK("batches"."recipient_encrypted" LIKE 'v1.%'),
	CONSTRAINT "batches_text_encrypted" CHECK("batches"."text_encrypted" LIKE 'v1.%'),
	CONSTRAINT "batches_recipient_lookup_sha256" CHECK(length("batches"."recipient_lookup_hash") = 64 AND "batches"."recipient_lookup_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "batches_created_nonnegative" CHECK("batches"."created_at" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `batches_invocation_unique` ON `batches` (`invocation_id`);--> statement-breakpoint
CREATE TABLE `bot_secrets` (
	`bot_id` text PRIMARY KEY NOT NULL,
	`bot_token_encrypted` text NOT NULL,
	`base_url` text NOT NULL,
	`webhook_bearer_hash` text NOT NULL,
	`webhook_bearer_last_four` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "bot_secrets_token_encrypted" CHECK("bot_secrets"."bot_token_encrypted" LIKE 'v1.%'),
	CONSTRAINT "bot_secrets_bearer_hash_sha256" CHECK(length("bot_secrets"."webhook_bearer_hash") = 64 AND "bot_secrets"."webhook_bearer_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "bot_secrets_bearer_last_four" CHECK(length("bot_secrets"."webhook_bearer_last_four") = 4),
	CONSTRAINT "bot_secrets_timestamps_nonnegative" CHECK("bot_secrets"."created_at" >= 0 AND "bot_secrets"."updated_at" >= "bot_secrets"."created_at")
);
--> statement-breakpoint
CREATE TABLE `bots` (
	`id` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`account_fingerprint` text NOT NULL,
	`ilink_bot_id_lookup_hash` text NOT NULL,
	`bound_user_fingerprint` text,
	`ilink_bot_id_encrypted` text NOT NULL,
	`ilink_user_id_encrypted` text NOT NULL,
	`remark` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`auth_status` text DEFAULT 'active' NOT NULL,
	`max_sends_per_minute` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "bots_id_uuid_v4" CHECK(length("bots"."id") = 36
      AND substr("bots"."id", 9, 1) = '-'
      AND substr("bots"."id", 14, 1) = '-'
      AND substr("bots"."id", 15, 1) = '4'
      AND substr("bots"."id", 19, 1) = '-'
      AND substr("bots"."id", 20, 1) IN ('8', '9', 'a', 'b')
      AND substr("bots"."id", 24, 1) = '-'
      AND "bots"."id" = lower("bots"."id")
      AND length(replace("bots"."id", '-', '')) = 32
      AND "bots"."id" NOT GLOB '*[^0-9a-f-]*'),
	CONSTRAINT "bots_public_id_uuid_v4" CHECK(length("bots"."public_id") = 36
      AND substr("bots"."public_id", 9, 1) = '-'
      AND substr("bots"."public_id", 14, 1) = '-'
      AND substr("bots"."public_id", 15, 1) = '4'
      AND substr("bots"."public_id", 19, 1) = '-'
      AND substr("bots"."public_id", 20, 1) IN ('8', '9', 'a', 'b')
      AND substr("bots"."public_id", 24, 1) = '-'
      AND "bots"."public_id" = lower("bots"."public_id")
      AND length(replace("bots"."public_id", '-', '')) = 32
      AND "bots"."public_id" NOT GLOB '*[^0-9a-f-]*'),
	CONSTRAINT "bots_upstream_lookup_sha256" CHECK(length("bots"."ilink_bot_id_lookup_hash") = 64 AND "bots"."ilink_bot_id_lookup_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "bots_account_fingerprint_format" CHECK(length("bots"."account_fingerprint") = 13
        AND substr("bots"."account_fingerprint", 1, 5) = 'acct_'
        AND substr("bots"."account_fingerprint", 6) NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "bots_bound_user_fingerprint_format" CHECK("bots"."bound_user_fingerprint" IS NULL OR (
        length("bots"."bound_user_fingerprint") = 13
        AND substr("bots"."bound_user_fingerprint", 1, 5) = 'user_'
        AND substr("bots"."bound_user_fingerprint", 6) NOT GLOB '*[^0-9a-f]*'
      )),
	CONSTRAINT "bots_ilink_bot_id_encrypted" CHECK("bots"."ilink_bot_id_encrypted" LIKE 'v1.%'),
	CONSTRAINT "bots_ilink_user_id_encrypted" CHECK("bots"."ilink_user_id_encrypted" LIKE 'v1.%'),
	CONSTRAINT "bots_remark_length" CHECK(length("bots"."remark") <= 200),
	CONSTRAINT "bots_enabled_boolean" CHECK("bots"."enabled" IN (0, 1)),
	CONSTRAINT "bots_auth_status_enum" CHECK("bots"."auth_status" IN ('active', 'reauth_required')),
	CONSTRAINT "bots_max_sends_per_minute_range" CHECK("bots"."max_sends_per_minute" BETWEEN 1 AND 600),
	CONSTRAINT "bots_timestamps_nonnegative" CHECK("bots"."created_at" >= 0 AND "bots"."updated_at" >= "bots"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bots_public_id_unique` ON `bots` (`public_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bots_upstream_lookup_unique` ON `bots` (`ilink_bot_id_lookup_hash`);--> statement-breakpoint
CREATE TABLE `conversation_contexts` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`user_id_encrypted` text NOT NULL,
	`user_lookup_hash` text NOT NULL,
	`user_fingerprint` text NOT NULL,
	`context_token_encrypted` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "conversation_contexts_id_uuid_v4" CHECK(length("conversation_contexts"."id") = 36
      AND substr("conversation_contexts"."id", 9, 1) = '-'
      AND substr("conversation_contexts"."id", 14, 1) = '-'
      AND substr("conversation_contexts"."id", 15, 1) = '4'
      AND substr("conversation_contexts"."id", 19, 1) = '-'
      AND substr("conversation_contexts"."id", 20, 1) IN ('8', '9', 'a', 'b')
      AND substr("conversation_contexts"."id", 24, 1) = '-'
      AND "conversation_contexts"."id" = lower("conversation_contexts"."id")
      AND length(replace("conversation_contexts"."id", '-', '')) = 32
      AND "conversation_contexts"."id" NOT GLOB '*[^0-9a-f-]*'),
	CONSTRAINT "conversation_contexts_user_id_encrypted" CHECK("conversation_contexts"."user_id_encrypted" LIKE 'v1.%'),
	CONSTRAINT "conversation_contexts_context_token_encrypted" CHECK("conversation_contexts"."context_token_encrypted" LIKE 'v1.%'),
	CONSTRAINT "conversation_contexts_user_lookup_sha256" CHECK(length("conversation_contexts"."user_lookup_hash") = 64 AND "conversation_contexts"."user_lookup_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "conversation_contexts_user_fingerprint_format" CHECK(length("conversation_contexts"."user_fingerprint") = 13
        AND substr("conversation_contexts"."user_fingerprint", 1, 5) = 'user_'
        AND substr("conversation_contexts"."user_fingerprint", 6) NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "conversation_contexts_timestamps_nonnegative" CHECK("conversation_contexts"."created_at" >= 0 AND "conversation_contexts"."updated_at" >= "conversation_contexts"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_contexts_bot_lookup_unique` ON `conversation_contexts` (`bot_id`,`user_lookup_hash`);--> statement-breakpoint
CREATE INDEX `conversation_contexts_bot_updated_idx` ON `conversation_contexts` (`bot_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `encryption_sentinel` (
	`id` integer PRIMARY KEY NOT NULL,
	`ciphertext` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "encryption_sentinel_singleton" CHECK("encryption_sentinel"."id" = 1),
	CONSTRAINT "encryption_sentinel_envelope" CHECK("encryption_sentinel"."ciphertext" LIKE 'v1.%'),
	CONSTRAINT "encryption_sentinel_created_nonnegative" CHECK("encryption_sentinel"."created_at" >= 0)
);
--> statement-breakpoint
CREATE TABLE `inbound_state` (
	`bot_id` text PRIMARY KEY NOT NULL,
	`cursor_encrypted` text,
	`last_polled_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "inbound_state_cursor_encrypted" CHECK("inbound_state"."cursor_encrypted" IS NULL OR "inbound_state"."cursor_encrypted" LIKE 'v1.%'),
	CONSTRAINT "inbound_state_timestamps_nonnegative" CHECK("inbound_state"."last_polled_at" IS NULL OR "inbound_state"."last_polled_at" >= 0),
	CONSTRAINT "inbound_state_updated_nonnegative" CHECK("inbound_state"."updated_at" >= 0)
);
--> statement-breakpoint
CREATE TABLE `invocations` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`bot_id` text,
	`status` text NOT NULL,
	`idempotency_scope` text,
	`idempotency_key_hash` text,
	`request_digest` text,
	`user_fingerprint` text NOT NULL,
	`response_http_status` integer,
	`response_body` text,
	`response_retry_after` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`deadline_at` integer NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "invocations_id_uuid_v4" CHECK(length("invocations"."id") = 36
      AND substr("invocations"."id", 9, 1) = '-'
      AND substr("invocations"."id", 14, 1) = '-'
      AND substr("invocations"."id", 15, 1) = '4'
      AND substr("invocations"."id", 19, 1) = '-'
      AND substr("invocations"."id", 20, 1) IN ('8', '9', 'a', 'b')
      AND substr("invocations"."id", 24, 1) = '-'
      AND "invocations"."id" = lower("invocations"."id")
      AND length(replace("invocations"."id", '-', '')) = 32
      AND "invocations"."id" NOT GLOB '*[^0-9a-f-]*'),
	CONSTRAINT "invocations_request_id_uuid_v4" CHECK(length("invocations"."request_id") = 36
      AND substr("invocations"."request_id", 9, 1) = '-'
      AND substr("invocations"."request_id", 14, 1) = '-'
      AND substr("invocations"."request_id", 15, 1) = '4'
      AND substr("invocations"."request_id", 19, 1) = '-'
      AND substr("invocations"."request_id", 20, 1) IN ('8', '9', 'a', 'b')
      AND substr("invocations"."request_id", 24, 1) = '-'
      AND "invocations"."request_id" = lower("invocations"."request_id")
      AND length(replace("invocations"."request_id", '-', '')) = 32
      AND "invocations"."request_id" NOT GLOB '*[^0-9a-f-]*'),
	CONSTRAINT "invocations_endpoint_enum" CHECK("invocations"."endpoint" IN ('single', 'admin_batch')),
	CONSTRAINT "invocations_status_enum" CHECK("invocations"."status" IN (
        'queued', 'leased', 'retry_wait', 'succeeded', 'partial', 'failed',
        'deadline_exceeded', 'cancelled'
      )),
	CONSTRAINT "invocations_idempotency_complete" CHECK(("invocations"."idempotency_scope" IS NULL
        AND "invocations"."idempotency_key_hash" IS NULL
        AND "invocations"."request_digest" IS NULL)
        OR ("invocations"."idempotency_scope" IS NOT NULL
          AND "invocations"."idempotency_key_hash" IS NOT NULL
          AND "invocations"."request_digest" IS NOT NULL)),
	CONSTRAINT "invocations_idempotency_hash" CHECK("invocations"."idempotency_key_hash" IS NULL OR (
        length("invocations"."idempotency_key_hash") = 64
        AND "invocations"."idempotency_key_hash" NOT GLOB '*[^0-9a-f]*'
      )),
	CONSTRAINT "invocations_request_digest" CHECK("invocations"."request_digest" IS NULL OR (
        length("invocations"."request_digest") = 64
        AND "invocations"."request_digest" NOT GLOB '*[^0-9a-f]*'
      )),
	CONSTRAINT "invocations_attempt_count_nonnegative" CHECK("invocations"."attempt_count" >= 0),
	CONSTRAINT "invocations_timestamps_nonnegative" CHECK("invocations"."created_at" >= 0
        AND "invocations"."updated_at" >= "invocations"."created_at"
        AND "invocations"."deadline_at" >= "invocations"."created_at"
        AND ("invocations"."completed_at" IS NULL OR "invocations"."completed_at" >= "invocations"."created_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invocations_request_id_unique` ON `invocations` (`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `invocations_idempotency_unique` ON `invocations` (`idempotency_scope`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `invocations_timeline_idx` ON `invocations` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `invocations_bot_timeline_idx` ON `invocations` (`bot_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`invocation_id` text NOT NULL,
	`batch_id` text,
	`batch_order` integer,
	`bot_id` text NOT NULL,
	`status` text NOT NULL,
	`client_id` text NOT NULL,
	`recipient_encrypted` text NOT NULL,
	`recipient_lookup_hash` text NOT NULL,
	`user_fingerprint` text NOT NULL,
	`text_encrypted` text NOT NULL,
	`context_token_encrypted` text NOT NULL,
	`admission_estimated_at` integer NOT NULL,
	`retry_not_before` integer NOT NULL,
	`owner_id` text,
	`lease_generation` integer DEFAULT 0 NOT NULL,
	`lease_until` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`deadline_at` integer NOT NULL,
	`message_id` text,
	`result_http_status` integer,
	`error_code` text,
	`error_message` text,
	`error_retryable` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`invocation_id`) REFERENCES `invocations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "jobs_id_uuid_v4" CHECK(length("jobs"."id") = 36
      AND substr("jobs"."id", 9, 1) = '-'
      AND substr("jobs"."id", 14, 1) = '-'
      AND substr("jobs"."id", 15, 1) = '4'
      AND substr("jobs"."id", 19, 1) = '-'
      AND substr("jobs"."id", 20, 1) IN ('8', '9', 'a', 'b')
      AND substr("jobs"."id", 24, 1) = '-'
      AND "jobs"."id" = lower("jobs"."id")
      AND length(replace("jobs"."id", '-', '')) = 32
      AND "jobs"."id" NOT GLOB '*[^0-9a-f-]*'),
	CONSTRAINT "jobs_status_enum" CHECK("jobs"."status" IN (
        'queued', 'leased', 'retry_wait', 'succeeded', 'failed',
        'deadline_exceeded', 'cancelled'
      )),
	CONSTRAINT "jobs_batch_order_consistent" CHECK(("jobs"."batch_id" IS NULL AND "jobs"."batch_order" IS NULL)
        OR ("jobs"."batch_id" IS NOT NULL AND "jobs"."batch_order" >= 0)),
	CONSTRAINT "jobs_lease_consistent" CHECK(("jobs"."status" = 'leased' AND "jobs"."owner_id" IS NOT NULL AND "jobs"."lease_until" IS NOT NULL)
        OR ("jobs"."status" <> 'leased' AND "jobs"."owner_id" IS NULL AND "jobs"."lease_until" IS NULL)),
	CONSTRAINT "jobs_lease_generation_nonnegative" CHECK("jobs"."lease_generation" >= 0),
	CONSTRAINT "jobs_attempt_count_nonnegative" CHECK("jobs"."attempt_count" >= 0),
	CONSTRAINT "jobs_error_retryable_boolean" CHECK("jobs"."error_retryable" IS NULL OR "jobs"."error_retryable" IN (0, 1)),
	CONSTRAINT "jobs_recipient_encrypted" CHECK("jobs"."recipient_encrypted" LIKE 'v1.%'),
	CONSTRAINT "jobs_text_encrypted" CHECK("jobs"."text_encrypted" LIKE 'v1.%'),
	CONSTRAINT "jobs_context_token_encrypted" CHECK("jobs"."context_token_encrypted" LIKE 'v1.%'),
	CONSTRAINT "jobs_recipient_lookup_sha256" CHECK(length("jobs"."recipient_lookup_hash") = 64 AND "jobs"."recipient_lookup_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "jobs_timestamps_nonnegative" CHECK("jobs"."created_at" >= 0
        AND "jobs"."updated_at" >= "jobs"."created_at"
        AND "jobs"."admission_estimated_at" >= 0
        AND "jobs"."retry_not_before" >= 0
        AND "jobs"."deadline_at" >= "jobs"."created_at"
        AND ("jobs"."lease_until" IS NULL OR "jobs"."lease_until" >= 0)
        AND ("jobs"."completed_at" IS NULL OR "jobs"."completed_at" >= "jobs"."created_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_client_id_unique` ON `jobs` (`client_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_invocation_bot_unique` ON `jobs` (`invocation_id`,`bot_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_batch_order_unique` ON `jobs` (`batch_id`,`batch_order`);--> statement-breakpoint
CREATE INDEX `jobs_bot_fifo_idx` ON `jobs` (`bot_id`,`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `jobs_bot_tail_idx` ON `jobs` (`bot_id`,`admission_estimated_at`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `jobs_lease_expiry_idx` ON `jobs` (`status`,`lease_until`);--> statement-breakpoint
CREATE TABLE `rate_state` (
	`bot_id` text PRIMARY KEY NOT NULL,
	`last_attempt_at` integer,
	`next_eligible_at` integer DEFAULT 0 NOT NULL,
	`cooldown_until` integer DEFAULT 0 NOT NULL,
	`consecutive_rate_limits` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "rate_state_nonnegative" CHECK(("rate_state"."last_attempt_at" IS NULL OR "rate_state"."last_attempt_at" >= 0)
        AND "rate_state"."next_eligible_at" >= 0
        AND "rate_state"."cooldown_until" >= 0
        AND "rate_state"."consecutive_rate_limits" >= 0
        AND "rate_state"."updated_at" >= 0)
);
--> statement-breakpoint
CREATE TABLE `service_lease` (
	`name` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`fencing_token` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "service_lease_singleton" CHECK("service_lease"."name" = 'primary'),
	CONSTRAINT "service_lease_owner_uuid_v4" CHECK(length("service_lease"."owner_id") = 36
      AND substr("service_lease"."owner_id", 9, 1) = '-'
      AND substr("service_lease"."owner_id", 14, 1) = '-'
      AND substr("service_lease"."owner_id", 15, 1) = '4'
      AND substr("service_lease"."owner_id", 19, 1) = '-'
      AND substr("service_lease"."owner_id", 20, 1) IN ('8', '9', 'a', 'b')
      AND substr("service_lease"."owner_id", 24, 1) = '-'
      AND "service_lease"."owner_id" = lower("service_lease"."owner_id")
      AND length(replace("service_lease"."owner_id", '-', '')) = 32
      AND "service_lease"."owner_id" NOT GLOB '*[^0-9a-f-]*'),
	CONSTRAINT "service_lease_fencing_positive" CHECK("service_lease"."fencing_token" >= 1),
	CONSTRAINT "service_lease_timestamps_nonnegative" CHECK("service_lease"."expires_at" >= 0 AND "service_lease"."updated_at" >= 0)
);
--> statement-breakpoint
INSERT INTO `admin_login_state` (`id`, `failed_attempts`, `updated_at`) VALUES (1, 0, 0);
