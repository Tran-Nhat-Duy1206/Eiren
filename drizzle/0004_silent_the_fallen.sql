CREATE TABLE "level_ignored_channels" (
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	CONSTRAINT "level_ignored_channels_guild_id_channel_id_pk" PRIMARY KEY("guild_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "level_rewards" (
	"guild_id" text NOT NULL,
	"level" integer NOT NULL,
	"role_id" text NOT NULL,
	CONSTRAINT "level_rewards_guild_id_level_role_id_pk" PRIMARY KEY("guild_id","level","role_id"),
	CONSTRAINT "level_rewards_level_check" CHECK ("level_rewards"."level" BETWEEN 1 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "levels_settings" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"cooldown_seconds" integer DEFAULT 60 NOT NULL,
	"xp_per_message" integer DEFAULT 10 NOT NULL,
	"min_length" integer DEFAULT 12 NOT NULL,
	"level_up_channel_id" text,
	CONSTRAINT "levels_settings_cooldown_check" CHECK ("levels_settings"."cooldown_seconds" BETWEEN 5 AND 3600),
	CONSTRAINT "levels_settings_xp_check" CHECK ("levels_settings"."xp_per_message" BETWEEN 1 AND 100),
	CONSTRAINT "levels_settings_min_length_check" CHECK ("levels_settings"."min_length" BETWEEN 0 AND 1000)
);
--> statement-breakpoint
CREATE TABLE "member_levels" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"xp" bigint DEFAULT 0 NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"last_xp_at" timestamp with time zone,
	"last_message_id" text,
	"last_fingerprint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_levels_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id"),
	CONSTRAINT "member_levels_xp_check" CHECK ("member_levels"."xp" >= 0),
	CONSTRAINT "member_levels_message_count_check" CHECK ("member_levels"."message_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "member_reputation" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_reputation_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id"),
	CONSTRAINT "member_reputation_score_check" CHECK ("member_reputation"."score" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reputation_grants" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"giver_id" text NOT NULL,
	"receiver_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reputation_grants_no_self_check" CHECK ("reputation_grants"."giver_id" <> "reputation_grants"."receiver_id")
);
--> statement-breakpoint
CREATE TABLE "reputation_settings" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"global_cooldown_seconds" integer DEFAULT 86400 NOT NULL,
	"same_target_cooldown_seconds" integer DEFAULT 604800 NOT NULL,
	CONSTRAINT "reputation_global_cooldown_check" CHECK ("reputation_settings"."global_cooldown_seconds" BETWEEN 60 AND 604800),
	CONSTRAINT "reputation_target_cooldown_check" CHECK ("reputation_settings"."same_target_cooldown_seconds" BETWEEN "reputation_settings"."global_cooldown_seconds" AND 2592000)
);
--> statement-breakpoint
CREATE TABLE "starboard_ignored_channels" (
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	CONSTRAINT "starboard_ignored_channels_guild_id_channel_id_pk" PRIMARY KEY("guild_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "starboard_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"source_channel_id" text NOT NULL,
	"source_message_id" text NOT NULL,
	"source_author_id" text NOT NULL,
	"starboard_channel_id" text,
	"starboard_message_id" text,
	"star_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "starboard_messages_status_check" CHECK ("starboard_messages"."status" IN ('PENDING','POSTED','REMOVED','DELETED')),
	CONSTRAINT "starboard_messages_count_check" CHECK ("starboard_messages"."star_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "starboard_settings" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"channel_id" text,
	"emoji" text DEFAULT '⭐' NOT NULL,
	"threshold" integer DEFAULT 5 NOT NULL,
	"allow_self" boolean DEFAULT false NOT NULL,
	"allow_bot_messages" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "starboard_settings_threshold_check" CHECK ("starboard_settings"."threshold" BETWEEN 1 AND 25),
	CONSTRAINT "starboard_settings_emoji_check" CHECK (length(trim("starboard_settings"."emoji")) BETWEEN 1 AND 100)
);
--> statement-breakpoint
ALTER TABLE "level_ignored_channels" ADD CONSTRAINT "level_ignored_channels_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "level_rewards" ADD CONSTRAINT "level_rewards_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "levels_settings" ADD CONSTRAINT "levels_settings_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_levels" ADD CONSTRAINT "member_levels_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_reputation" ADD CONSTRAINT "member_reputation_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_grants" ADD CONSTRAINT "reputation_grants_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_settings" ADD CONSTRAINT "reputation_settings_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "starboard_ignored_channels" ADD CONSTRAINT "starboard_ignored_channels_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "starboard_messages" ADD CONSTRAINT "starboard_messages_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "starboard_settings" ADD CONSTRAINT "starboard_settings_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_levels_leaderboard_idx" ON "member_levels" USING btree ("guild_id","xp" DESC NULLS LAST,"user_id");--> statement-breakpoint
CREATE INDEX "member_reputation_guild_score_idx" ON "member_reputation" USING btree ("guild_id","score" DESC NULLS LAST,"user_id");--> statement-breakpoint
CREATE INDEX "reputation_grants_giver_recent_idx" ON "reputation_grants" USING btree ("guild_id","giver_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reputation_grants_target_recent_idx" ON "reputation_grants" USING btree ("guild_id","giver_id","receiver_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reputation_grants_receiver_idx" ON "reputation_grants" USING btree ("guild_id","receiver_id");--> statement-breakpoint
CREATE UNIQUE INDEX "starboard_messages_source_unique" ON "starboard_messages" USING btree ("guild_id","source_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "starboard_messages_post_unique" ON "starboard_messages" USING btree ("guild_id","starboard_message_id");--> statement-breakpoint
CREATE INDEX "starboard_messages_guild_status_idx" ON "starboard_messages" USING btree ("guild_id","status");