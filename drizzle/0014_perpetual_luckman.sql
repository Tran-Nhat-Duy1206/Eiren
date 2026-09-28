CREATE TABLE "ai_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"request_key" text NOT NULL,
	"usage_day" date NOT NULL,
	"epoch" integer NOT NULL,
	"status" text DEFAULT 'RESERVED' NOT NULL,
	"model_id" text NOT NULL,
	"reserved_input_tokens" integer NOT NULL,
	"reserved_output_tokens" integer NOT NULL,
	"reserved_cost_micros" bigint NOT NULL,
	"actual_input_tokens" integer,
	"actual_output_tokens" integer,
	"actual_cost_micros" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "ai_requests_user_check" CHECK ("ai_requests"."user_id" ~ '^[0-9]{17,20}$'),
	CONSTRAINT "ai_requests_key_check" CHECK (length("ai_requests"."request_key") BETWEEN 1 AND 128),
	CONSTRAINT "ai_requests_status_check" CHECK ("ai_requests"."status" IN ('RESERVED','SETTLED','EXPIRED')),
	CONSTRAINT "ai_requests_epoch_check" CHECK ("ai_requests"."epoch" >= 0),
	CONSTRAINT "ai_requests_amount_check" CHECK ("ai_requests"."reserved_input_tokens" BETWEEN 0 AND 2048 AND
    "ai_requests"."reserved_output_tokens" BETWEEN 1 AND 512 AND "ai_requests"."reserved_cost_micros" >= 0 AND
    ("ai_requests"."actual_input_tokens" IS NULL OR "ai_requests"."actual_input_tokens" BETWEEN 0 AND 2048) AND
    ("ai_requests"."actual_output_tokens" IS NULL OR "ai_requests"."actual_output_tokens" BETWEEN 0 AND 512) AND
    ("ai_requests"."actual_cost_micros" IS NULL OR "ai_requests"."actual_cost_micros" BETWEEN 0 AND "ai_requests"."reserved_cost_micros")),
	CONSTRAINT "ai_requests_settlement_check" CHECK (("ai_requests"."status" = 'RESERVED' AND "ai_requests"."settled_at" IS NULL AND "ai_requests"."actual_cost_micros" IS NULL) OR
    ("ai_requests"."status" <> 'RESERVED' AND "ai_requests"."settled_at" IS NOT NULL AND "ai_requests"."actual_cost_micros" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ai_settings" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"model_id" text NOT NULL,
	"guild_requests_per_day" integer,
	"user_requests_per_day" integer,
	"monthly_budget_micros" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_settings_provider_check" CHECK (length("ai_settings"."provider_id") BETWEEN 1 AND 64 AND "ai_settings"."provider_id" ~ '^[a-z0-9_-]+$'),
	CONSTRAINT "ai_settings_model_check" CHECK (length("ai_settings"."model_id") BETWEEN 1 AND 100 AND "ai_settings"."model_id" ~ '^[A-Za-z0-9._:/-]+$'),
	CONSTRAINT "ai_settings_caps_check" CHECK (("ai_settings"."guild_requests_per_day" IS NULL OR "ai_settings"."guild_requests_per_day" BETWEEN 1 AND 25) AND
    ("ai_settings"."user_requests_per_day" IS NULL OR "ai_settings"."user_requests_per_day" BETWEEN 1 AND 10) AND
    ("ai_settings"."monthly_budget_micros" IS NULL OR "ai_settings"."monthly_budget_micros" BETWEEN 1 AND 5000000))
);
--> statement-breakpoint
CREATE TABLE "ai_usage_daily" (
	"guild_id" text NOT NULL,
	"utc_day" date NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"rejected" integer DEFAULT 0 NOT NULL,
	"reserved_cost_micros" bigint DEFAULT 0 NOT NULL,
	"settled_cost_micros" bigint DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_usage_daily_guild_id_utc_day_pk" PRIMARY KEY("guild_id","utc_day"),
	CONSTRAINT "ai_usage_nonnegative_check" CHECK ("ai_usage_daily"."requests" >= 0 AND "ai_usage_daily"."rejected" >= 0 AND
    "ai_usage_daily"."reserved_cost_micros" >= 0 AND "ai_usage_daily"."settled_cost_micros" >= 0 AND
    "ai_usage_daily"."input_tokens" >= 0 AND "ai_usage_daily"."output_tokens" >= 0)
);
--> statement-breakpoint
CREATE TABLE "automation_action_runs" (
	"execution_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"discord_message_id" text,
	"safe_error_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_action_runs_execution_id_position_pk" PRIMARY KEY("execution_id","position"),
	CONSTRAINT "automation_action_runs_position_check" CHECK ("automation_action_runs"."position" BETWEEN 0 AND 1),
	CONSTRAINT "automation_action_runs_status_check" CHECK ("automation_action_runs"."status" IN ('PENDING','RUNNING','SUCCEEDED','SKIPPED','FAILED','UNCERTAIN')),
	CONSTRAINT "automation_action_runs_attempt_check" CHECK ("automation_action_runs"."attempts" BETWEEN 0 AND 5),
	CONSTRAINT "automation_action_runs_message_check" CHECK ("automation_action_runs"."discord_message_id" IS NULL OR "automation_action_runs"."discord_message_id" ~ '^[0-9]{17,20}$'),
	CONSTRAINT "automation_action_runs_error_check" CHECK ("automation_action_runs"."safe_error_code" IS NULL OR "automation_action_runs"."safe_error_code" ~ '^[A-Z_]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "automation_actions" (
	"automation_id" bigint NOT NULL,
	"position" integer NOT NULL,
	"action_key" text NOT NULL,
	"action_version" integer NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "automation_actions_automation_id_position_pk" PRIMARY KEY("automation_id","position"),
	CONSTRAINT "automation_actions_position_check" CHECK ("automation_actions"."position" BETWEEN 0 AND 1),
	CONSTRAINT "automation_actions_kind_check" CHECK ("automation_actions"."action_key" IN ('STATIC_MESSAGE','STAFF_LOG') AND "automation_actions"."action_version" BETWEEN 1 AND 100),
	CONSTRAINT "automation_actions_config_check" CHECK (jsonb_typeof("automation_actions"."config") = 'object' AND octet_length("automation_actions"."config"::text) <= 2048 AND
    ("automation_actions"."action_key" <> 'STATIC_MESSAGE' OR length(coalesce("automation_actions"."config"->>'text', '')) <= 1000))
);
--> statement-breakpoint
CREATE TABLE "automation_executions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"automation_id" bigint NOT NULL,
	"trigger_key" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"module_epoch" integer NOT NULL,
	"config_version" integer NOT NULL,
	"causation_id" uuid,
	"chain_depth" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claim_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"safe_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "automation_executions_trigger_check" CHECK (length("automation_executions"."trigger_key") BETWEEN 1 AND 128),
	CONSTRAINT "automation_executions_status_check" CHECK ("automation_executions"."status" IN ('PENDING','RUNNING','SUCCEEDED','SKIPPED','FAILED','UNCERTAIN')),
	CONSTRAINT "automation_executions_bounds_check" CHECK ("automation_executions"."module_epoch" >= 0 AND "automation_executions"."config_version" > 0 AND
    "automation_executions"."chain_depth" BETWEEN 0 AND 2 AND "automation_executions"."attempts" BETWEEN 0 AND 5),
	CONSTRAINT "automation_executions_error_check" CHECK ("automation_executions"."safe_error_code" IS NULL OR "automation_executions"."safe_error_code" ~ '^[A-Z_]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"trigger_key" text NOT NULL,
	"trigger_version" integer NOT NULL,
	"trigger_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"authorized_by" text NOT NULL,
	"approved_capability" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"next_run_at" timestamp with time zone,
	"cooldown_seconds" integer DEFAULT 60 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automations_name_check" CHECK (length("automations"."name") BETWEEN 1 AND 80),
	CONSTRAINT "automations_trigger_check" CHECK ("automations"."trigger_key" IN ('SCHEDULED') AND "automations"."trigger_version" BETWEEN 1 AND 100),
	CONSTRAINT "automations_config_check" CHECK (jsonb_typeof("automations"."trigger_config") = 'object' AND octet_length("automations"."trigger_config"::text) <= 2048),
	CONSTRAINT "automations_version_check" CHECK ("automations"."config_version" BETWEEN 1 AND 2147483647),
	CONSTRAINT "automations_authorizer_check" CHECK ("automations"."authorized_by" ~ '^[0-9]{17,20}$'),
	CONSTRAINT "automations_capability_check" CHECK ("automations"."approved_capability" IN ('SEND_MESSAGE','STAFF_LOG')),
	CONSTRAINT "automations_timezone_check" CHECK (length("automations"."timezone") BETWEEN 1 AND 64),
	CONSTRAINT "automations_cooldown_check" CHECK ("automations"."cooldown_seconds" BETWEEN 0 AND 86400)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "automations_guild_id_unique" ON "automations" USING btree ("guild_id","id");--> statement-breakpoint
ALTER TABLE "ai_requests" ADD CONSTRAINT "ai_requests_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_requests" ADD CONSTRAINT "ai_requests_usage_day_fk" FOREIGN KEY ("guild_id","usage_day") REFERENCES "public"."ai_usage_daily"("guild_id","utc_day") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_daily" ADD CONSTRAINT "ai_usage_daily_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_action_runs" ADD CONSTRAINT "automation_action_runs_execution_id_automation_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."automation_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_actions" ADD CONSTRAINT "automation_actions_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_executions" ADD CONSTRAINT "automation_executions_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_executions" ADD CONSTRAINT "automation_executions_guild_automation_fk" FOREIGN KEY ("guild_id","automation_id") REFERENCES "public"."automations"("guild_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_requests_guild_key_unique" ON "ai_requests" USING btree ("guild_id","request_key");--> statement-breakpoint
CREATE INDEX "ai_requests_user_created_idx" ON "ai_requests" USING btree ("guild_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_requests_live_idx" ON "ai_requests" USING btree ("guild_id","status","lease_until");--> statement-breakpoint
CREATE INDEX "ai_requests_retention_idx" ON "ai_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_day_idx" ON "ai_usage_daily" USING btree ("utc_day");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_executions_trigger_unique" ON "automation_executions" USING btree ("guild_id","automation_id","trigger_key");--> statement-breakpoint
CREATE INDEX "automation_executions_due_idx" ON "automation_executions" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "automation_executions_retention_idx" ON "automation_executions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "automations_due_idx" ON "automations" USING btree ("enabled","next_run_at","id");--> statement-breakpoint
CREATE INDEX "automations_guild_enabled_idx" ON "automations" USING btree ("guild_id","enabled");