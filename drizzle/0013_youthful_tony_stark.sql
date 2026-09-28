ALTER TABLE "analytics_active_voice_sessions" ADD COLUMN "observation_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "analytics_active_voice_sessions" ADD COLUMN "observation_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "analytics_active_voice_sessions" ADD COLUMN "pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "guild_modules" ADD COLUMN "voice_sequence" bigint DEFAULT 0 NOT NULL;