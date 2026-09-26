CREATE TABLE "community_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"creator_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone,
	"channel_id" text NOT NULL,
	"announcement_message_id" text,
	"max_participants" integer,
	"status" text DEFAULT 'SCHEDULED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_events_status_check" CHECK ("community_events"."status" IN ('SCHEDULED','ACTIVE','COMPLETED','CANCELLED')),
	CONSTRAINT "community_events_time_check" CHECK ("community_events"."end_at" IS NULL OR "community_events"."end_at" > "community_events"."start_at"),
	CONSTRAINT "community_events_capacity_check" CHECK ("community_events"."max_participants" IS NULL OR "community_events"."max_participants" BETWEEN 1 AND 10000),
	CONSTRAINT "community_events_title_check" CHECK (length(trim("community_events"."title")) BETWEEN 1 AND 256),
	CONSTRAINT "community_events_description_check" CHECK (length("community_events"."description") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "event_attendance" (
	"event_id" bigint NOT NULL,
	"user_id" text NOT NULL,
	"marked_by" text NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_attendance_event_id_user_id_pk" PRIMARY KEY("event_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "event_participants" (
	"event_id" bigint NOT NULL,
	"user_id" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_participants_event_id_user_id_pk" PRIMARY KEY("event_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "event_reminders" (
	"event_id" bigint NOT NULL,
	"offset_seconds" integer NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"claimed_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_reminders_event_id_offset_seconds_pk" PRIMARY KEY("event_id","offset_seconds"),
	CONSTRAINT "event_reminders_offset_check" CHECK ("event_reminders"."offset_seconds" IN (600,3600,86400)),
	CONSTRAINT "event_reminders_status_check" CHECK ("event_reminders"."status" IN ('PENDING','PROCESSING','DELIVERED','CANCELLED'))
);
--> statement-breakpoint
CREATE TABLE "giveaway_draws" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"giveaway_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "giveaway_draws_kind_check" CHECK ("giveaway_draws"."kind" IN ('ORIGINAL','REROLL'))
);
--> statement-breakpoint
CREATE TABLE "giveaway_entries" (
	"giveaway_id" bigint NOT NULL,
	"user_id" text NOT NULL,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "giveaway_entries_giveaway_id_user_id_pk" PRIMARY KEY("giveaway_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "giveaway_winners" (
	"draw_id" bigint NOT NULL,
	"giveaway_id" bigint NOT NULL,
	"user_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	CONSTRAINT "giveaway_winners_draw_id_user_id_pk" PRIMARY KEY("draw_id","user_id"),
	CONSTRAINT "giveaway_winners_ordinal_check" CHECK ("giveaway_winners"."ordinal" BETWEEN 1 AND 20)
);
--> statement-breakpoint
CREATE TABLE "giveaways" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"creator_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text,
	"prize" text NOT NULL,
	"start_at" timestamp with time zone DEFAULT now() NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"winner_count" integer NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"required_role_id" text,
	"min_account_age_seconds" integer,
	"min_guild_age_seconds" integer,
	"require_verified" boolean DEFAULT false NOT NULL,
	"min_level" integer,
	"result_announcement_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "giveaways_prize_check" CHECK (length(trim("giveaways"."prize")) BETWEEN 1 AND 256),
	CONSTRAINT "giveaways_time_check" CHECK ("giveaways"."end_at" > "giveaways"."start_at"),
	CONSTRAINT "giveaways_winners_check" CHECK ("giveaways"."winner_count" BETWEEN 1 AND 20),
	CONSTRAINT "giveaways_status_check" CHECK ("giveaways"."status" IN ('ACTIVE','ENDED','CANCELLED')),
	CONSTRAINT "giveaways_account_age_check" CHECK ("giveaways"."min_account_age_seconds" IS NULL OR "giveaways"."min_account_age_seconds" >= 0),
	CONSTRAINT "giveaways_guild_age_check" CHECK ("giveaways"."min_guild_age_seconds" IS NULL OR "giveaways"."min_guild_age_seconds" >= 0),
	CONSTRAINT "giveaways_min_level_check" CHECK ("giveaways"."min_level" IS NULL OR "giveaways"."min_level" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "member_achievements" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"achievement_id" text NOT NULL,
	"awarded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_achievements_guild_id_user_id_achievement_id_pk" PRIMARY KEY("guild_id","user_id","achievement_id")
);
--> statement-breakpoint
CREATE TABLE "tempvoice_rooms" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"channel_id" text,
	"status" text DEFAULT 'CREATING' NOT NULL,
	"empty_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tempvoice_rooms_status_check" CHECK ("tempvoice_rooms"."status" IN ('CREATING','ACTIVE','DELETING','CLOSED')),
	CONSTRAINT "tempvoice_rooms_active_channel_check" CHECK ("tempvoice_rooms"."status" NOT IN ('ACTIVE','DELETING') OR "tempvoice_rooms"."channel_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "tempvoice_settings" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"lobby_channel_id" text,
	"category_id" text,
	"user_limit" integer DEFAULT 0 NOT NULL,
	"default_private" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tempvoice_settings_limit_check" CHECK ("tempvoice_settings"."user_limit" BETWEEN 0 AND 99),
	CONSTRAINT "tempvoice_settings_lobby_check" CHECK (NOT "tempvoice_settings"."enabled" OR "tempvoice_settings"."lobby_channel_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "community_events" ADD CONSTRAINT "community_events_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendance" ADD CONSTRAINT "event_attendance_event_id_community_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."community_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_participants" ADD CONSTRAINT "event_participants_event_id_community_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."community_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_reminders" ADD CONSTRAINT "event_reminders_event_id_community_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."community_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giveaway_draws" ADD CONSTRAINT "giveaway_draws_giveaway_id_giveaways_id_fk" FOREIGN KEY ("giveaway_id") REFERENCES "public"."giveaways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giveaway_entries" ADD CONSTRAINT "giveaway_entries_giveaway_id_giveaways_id_fk" FOREIGN KEY ("giveaway_id") REFERENCES "public"."giveaways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giveaway_winners" ADD CONSTRAINT "giveaway_winners_draw_id_giveaway_draws_id_fk" FOREIGN KEY ("draw_id") REFERENCES "public"."giveaway_draws"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giveaway_winners" ADD CONSTRAINT "giveaway_winners_giveaway_id_giveaways_id_fk" FOREIGN KEY ("giveaway_id") REFERENCES "public"."giveaways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giveaways" ADD CONSTRAINT "giveaways_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_achievements" ADD CONSTRAINT "member_achievements_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tempvoice_rooms" ADD CONSTRAINT "tempvoice_rooms_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tempvoice_settings" ADD CONSTRAINT "tempvoice_settings_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "community_events_guild_start_idx" ON "community_events" USING btree ("guild_id","start_at");--> statement-breakpoint
CREATE INDEX "community_events_due_idx" ON "community_events" USING btree ("status","start_at","end_at");--> statement-breakpoint
CREATE INDEX "event_reminders_status_claim_idx" ON "event_reminders" USING btree ("status","claimed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "giveaway_draws_original_unique" ON "giveaway_draws" USING btree ("giveaway_id") WHERE "giveaway_draws"."kind" = 'ORIGINAL';--> statement-breakpoint
CREATE INDEX "giveaway_draws_giveaway_idx" ON "giveaway_draws" USING btree ("giveaway_id");--> statement-breakpoint
CREATE UNIQUE INDEX "giveaway_winners_draw_ordinal_unique" ON "giveaway_winners" USING btree ("draw_id","ordinal");--> statement-breakpoint
CREATE INDEX "giveaway_winners_giveaway_idx" ON "giveaway_winners" USING btree ("giveaway_id","user_id");--> statement-breakpoint
CREATE INDEX "giveaways_guild_status_idx" ON "giveaways" USING btree ("guild_id","status");--> statement-breakpoint
CREATE INDEX "giveaways_due_idx" ON "giveaways" USING btree ("status","end_at");--> statement-breakpoint
CREATE INDEX "member_achievements_member_awarded_idx" ON "member_achievements" USING btree ("guild_id","user_id","awarded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tempvoice_rooms_active_owner_unique" ON "tempvoice_rooms" USING btree ("guild_id","owner_id") WHERE "tempvoice_rooms"."status" IN ('CREATING','ACTIVE','DELETING');--> statement-breakpoint
CREATE UNIQUE INDEX "tempvoice_rooms_guild_channel_unique" ON "tempvoice_rooms" USING btree ("guild_id","channel_id");--> statement-breakpoint
CREATE INDEX "tempvoice_rooms_empty_due_idx" ON "tempvoice_rooms" USING btree ("status","empty_since");