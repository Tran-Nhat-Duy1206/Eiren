CREATE TABLE "moderation_cases" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"target_id" text NOT NULL,
	"moderator_id" text NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"duration_seconds" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"claimed_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "moderation_cases_action_check" CHECK ("moderation_cases"."action" IN ('WARN','TIMEOUT','KICK','BAN','TEMPBAN','UNBAN','PURGE')),
	CONSTRAINT "moderation_cases_status_check" CHECK ("moderation_cases"."status" IN ('PENDING','ACTIVE','COMPLETED','PROCESSING','EXPIRED','SUPERSEDED','FAILED')),
	CONSTRAINT "moderation_cases_duration_check" CHECK ("moderation_cases"."duration_seconds" IS NULL OR "moderation_cases"."duration_seconds" > 0),
	CONSTRAINT "moderation_cases_expiry_check" CHECK ("moderation_cases"."action" NOT IN ('TEMPBAN','TIMEOUT') OR ("moderation_cases"."expires_at" IS NOT NULL AND "moderation_cases"."duration_seconds" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "moderator_notes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"target_id" text NOT NULL,
	"moderator_id" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderator_notes_content_check" CHECK (length(trim("moderator_notes"."content")) > 0)
);
--> statement-breakpoint
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderator_notes" ADD CONSTRAINT "moderator_notes_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moderation_cases_guild_target_created_idx" ON "moderation_cases" USING btree ("guild_id","target_id","created_at");--> statement-breakpoint
CREATE INDEX "moderation_cases_due_idx" ON "moderation_cases" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "moderator_notes_guild_target_created_idx" ON "moderator_notes" USING btree ("guild_id","target_id","created_at");