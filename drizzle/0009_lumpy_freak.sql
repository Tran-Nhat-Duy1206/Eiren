CREATE TABLE "analytics_active_voice_sessions" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "analytics_active_voice_sessions_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "analytics_channel_hourly" (
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"messages" bigint DEFAULT 0 NOT NULL,
	"voice_seconds" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "analytics_channel_hourly_guild_id_channel_id_bucket_start_pk" PRIMARY KEY("guild_id","channel_id","bucket_start"),
	CONSTRAINT "analytics_channel_hourly_nonnegative_check" CHECK ("analytics_channel_hourly"."messages" >= 0 AND "analytics_channel_hourly"."voice_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "analytics_command_hourly" (
	"guild_id" text NOT NULL,
	"command_name" text NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"invocations" bigint DEFAULT 0 NOT NULL,
	"errors" bigint DEFAULT 0 NOT NULL,
	"total_duration_ms" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "analytics_command_hourly_guild_id_command_name_bucket_start_pk" PRIMARY KEY("guild_id","command_name","bucket_start"),
	CONSTRAINT "analytics_command_hourly_nonnegative_check" CHECK ("analytics_command_hourly"."invocations" >= 0 AND "analytics_command_hourly"."errors" >= 0 AND "analytics_command_hourly"."total_duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "analytics_event_dedupe" (
	"guild_id" text NOT NULL,
	"event_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytics_event_dedupe_guild_id_event_key_pk" PRIMARY KEY("guild_id","event_key"),
	CONSTRAINT "analytics_event_dedupe_key_check" CHECK (length("analytics_event_dedupe"."event_key") BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "analytics_guild_hourly" (
	"guild_id" text NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"messages" bigint DEFAULT 0 NOT NULL,
	"joins" bigint DEFAULT 0 NOT NULL,
	"leaves" bigint DEFAULT 0 NOT NULL,
	"voice_seconds" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "analytics_guild_hourly_guild_id_bucket_start_pk" PRIMARY KEY("guild_id","bucket_start"),
	CONSTRAINT "analytics_guild_hourly_nonnegative_check" CHECK ("analytics_guild_hourly"."messages" >= 0 AND "analytics_guild_hourly"."joins" >= 0 AND "analytics_guild_hourly"."leaves" >= 0 AND "analytics_guild_hourly"."voice_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "analytics_member_state" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"present" boolean NOT NULL,
	"last_changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "analytics_member_state_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "analytics_settings" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"retention_days" integer DEFAULT 180 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytics_settings_retention_check" CHECK ("analytics_settings"."retention_days" BETWEEN 30 AND 730)
);
--> statement-breakpoint
CREATE TABLE "dashboard_audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"success" boolean NOT NULL,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboard_audit_action_check" CHECK (length("dashboard_audit_log"."action") BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE TABLE "dashboard_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"oauth_guild_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "dashboard_sessions_expiry_check" CHECK ("dashboard_sessions"."expires_at" <= "dashboard_sessions"."absolute_expires_at")
);
--> statement-breakpoint
ALTER TABLE "analytics_active_voice_sessions" ADD CONSTRAINT "analytics_active_voice_sessions_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_channel_hourly" ADD CONSTRAINT "analytics_channel_hourly_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_command_hourly" ADD CONSTRAINT "analytics_command_hourly_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_event_dedupe" ADD CONSTRAINT "analytics_event_dedupe_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_guild_hourly" ADD CONSTRAINT "analytics_guild_hourly_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_member_state" ADD CONSTRAINT "analytics_member_state_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_settings" ADD CONSTRAINT "analytics_settings_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_audit_log" ADD CONSTRAINT "dashboard_audit_log_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analytics_active_voice_updated_idx" ON "analytics_active_voice_sessions" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "analytics_channel_hourly_bucket_idx" ON "analytics_channel_hourly" USING btree ("bucket_start");--> statement-breakpoint
CREATE INDEX "analytics_command_hourly_bucket_idx" ON "analytics_command_hourly" USING btree ("bucket_start");--> statement-breakpoint
CREATE INDEX "analytics_event_dedupe_created_idx" ON "analytics_event_dedupe" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "analytics_guild_hourly_bucket_idx" ON "analytics_guild_hourly" USING btree ("bucket_start");--> statement-breakpoint
CREATE INDEX "analytics_member_state_changed_idx" ON "analytics_member_state" USING btree ("last_changed_at");--> statement-breakpoint
CREATE INDEX "dashboard_audit_guild_created_idx" ON "dashboard_audit_log" USING btree ("guild_id","created_at");--> statement-breakpoint
CREATE INDEX "dashboard_sessions_expiry_idx" ON "dashboard_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "dashboard_sessions_absolute_idx" ON "dashboard_sessions" USING btree ("absolute_expires_at");