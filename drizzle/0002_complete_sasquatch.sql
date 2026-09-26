CREATE TABLE "antiraid_settings" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"join_window_seconds" integer DEFAULT 60 NOT NULL,
	"join_threshold" integer DEFAULT 5 NOT NULL,
	"young_account_age_seconds" integer DEFAULT 604800 NOT NULL,
	"young_account_weight" integer DEFAULT 25 NOT NULL,
	"message_spam_threshold" integer DEFAULT 10 NOT NULL,
	"message_spam_window_seconds" integer DEFAULT 30 NOT NULL,
	"mention_threshold" integer DEFAULT 5 NOT NULL,
	"auto_quarantine" boolean DEFAULT true NOT NULL,
	"alert_channel_id" text,
	"emergency_mode" boolean DEFAULT false NOT NULL,
	"emergency_activated_at" timestamp with time zone,
	"emergency_reason" text,
	"emergency_actor_id" text,
	"emergency_join_count" integer,
	"emergency_window_seconds" integer,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "antiraid_settings_window_check" CHECK ("antiraid_settings"."join_window_seconds" > 0 AND "antiraid_settings"."message_spam_window_seconds" > 0),
	CONSTRAINT "antiraid_settings_threshold_check" CHECK ("antiraid_settings"."join_threshold" > 0 AND "antiraid_settings"."message_spam_threshold" > 0),
	CONSTRAINT "antiraid_settings_age_check" CHECK ("antiraid_settings"."young_account_age_seconds" >= 0 AND "antiraid_settings"."young_account_weight" >= 0 AND "antiraid_settings"."mention_threshold" >= 0)
);
--> statement-breakpoint
CREATE TABLE "join_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	"account_created_at" timestamp with time zone,
	"account_age_seconds" integer,
	"verification_status" text,
	"risk_score" integer DEFAULT 0 NOT NULL,
	"signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "join_history_risk_score_check" CHECK ("join_history"."risk_score" >= 0)
);
--> statement-breakpoint
CREATE TABLE "member_verifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"method" text,
	"reason" text,
	"account_created_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"rejected_at" timestamp with time zone,
	"rejected_by" text,
	"rules_acknowledged_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "member_verifications_status_check" CHECK ("member_verifications"."status" IN ('PENDING','VERIFIED','REJECTED','BYPASSED')),
	CONSTRAINT "member_verifications_method_check" CHECK ("member_verifications"."method" IS NULL OR "member_verifications"."method" IN ('BUTTON','MANUAL','AUTO'))
);
--> statement-breakpoint
CREATE TABLE "verification_settings" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"mode" text DEFAULT 'BUTTON' NOT NULL,
	"verification_channel_id" text,
	"verified_role_id" text,
	"quarantine_role_id" text,
	"min_account_age_seconds" integer,
	"require_rules_ack" boolean DEFAULT false NOT NULL,
	"panel_message_id" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_settings_mode_check" CHECK ("verification_settings"."mode" IN ('BUTTON','MANUAL','BUTTON_AND_ACCOUNT_AGE')),
	CONSTRAINT "verification_settings_min_age_check" CHECK ("verification_settings"."min_account_age_seconds" IS NULL OR "verification_settings"."min_account_age_seconds" > 0)
);
--> statement-breakpoint
ALTER TABLE "antiraid_settings" ADD CONSTRAINT "antiraid_settings_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_history" ADD CONSTRAINT "join_history_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_verifications" ADD CONSTRAINT "member_verifications_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_settings" ADD CONSTRAINT "verification_settings_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "join_history_guild_user_joined_unique" ON "join_history" USING btree ("guild_id","user_id","joined_at");--> statement-breakpoint
CREATE INDEX "join_history_guild_joined_idx" ON "join_history" USING btree ("guild_id","joined_at");--> statement-breakpoint
CREATE UNIQUE INDEX "member_verifications_guild_user_unique" ON "member_verifications" USING btree ("guild_id","user_id");--> statement-breakpoint
CREATE INDEX "member_verifications_guild_status_idx" ON "member_verifications" USING btree ("guild_id","status");