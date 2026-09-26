CREATE TABLE "appeals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"appellant_id" text NOT NULL,
	"case_id" bigint,
	"reason" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"reviewer_id" text,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "appeals_status_check" CHECK ("appeals"."status" IN ('PENDING','ACCEPTED','REJECTED'))
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"reporter_id" text NOT NULL,
	"reported_user_id" text,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"evidence_url" text,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"assigned_staff_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"resolution_note" text,
	CONSTRAINT "reports_status_check" CHECK ("reports"."status" IN ('OPEN','UNDER_REVIEW','CLOSED'))
);
--> statement-breakpoint
CREATE TABLE "role_menu_options" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"menu_id" bigint NOT NULL,
	"role_id" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"required_role_id" text,
	"forbidden_role_id" text,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_menus" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'BUTTON' NOT NULL,
	"exclusive" boolean DEFAULT false NOT NULL,
	"max_values" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"channel_id" text,
	"message_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_menus_kind_check" CHECK ("role_menus"."kind" IN ('BUTTON','SELECT')),
	CONSTRAINT "role_menus_max_check" CHECK ("role_menus"."max_values" BETWEEN 1 AND 25)
);
--> statement-breakpoint
CREATE TABLE "suggestion_settings" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"channel_id" text
);
--> statement-breakpoint
CREATE TABLE "suggestion_votes" (
	"suggestion_id" bigint NOT NULL,
	"user_id" text NOT NULL,
	"vote" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suggestion_votes_suggestion_id_user_id_pk" PRIMARY KEY("suggestion_id","user_id"),
	CONSTRAINT "suggestion_votes_value_check" CHECK ("suggestion_votes"."vote" IN (-1, 1))
);
--> statement-breakpoint
CREATE TABLE "suggestions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"author_id" text NOT NULL,
	"content" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"channel_id" text,
	"message_id" text,
	"staff_response" text,
	"reviewed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suggestions_status_check" CHECK ("suggestions"."status" IN ('PENDING','UNDER_REVIEW','ACCEPTED','REJECTED','IMPLEMENTED'))
);
--> statement-breakpoint
CREATE TABLE "ticket_participants" (
	"ticket_id" bigint NOT NULL,
	"user_id" text NOT NULL,
	"added_by" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_participants_ticket_id_user_id_pk" PRIMARY KEY("ticket_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "ticket_settings" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"staff_role_id" text,
	"transcript_channel_id" text,
	"max_active_tickets" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "ticket_settings_max_active_check" CHECK ("ticket_settings"."max_active_tickets" BETWEEN 1 AND 10)
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"creator_id" text NOT NULL,
	"type" text NOT NULL,
	"channel_id" text,
	"assigned_staff_id" text,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"close_reason" text,
	"transcript" text,
	"transcript_generated_at" timestamp with time zone,
	CONSTRAINT "tickets_type_check" CHECK ("tickets"."type" IN ('SUPPORT','REPORT','APPEAL','PARTNERSHIP','BUG_REPORT','OTHER')),
	CONSTRAINT "tickets_status_check" CHECK ("tickets"."status" IN ('OPEN','CLAIMED','CLOSED'))
);
--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_case_id_moderation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_menu_options" ADD CONSTRAINT "role_menu_options_menu_id_role_menus_id_fk" FOREIGN KEY ("menu_id") REFERENCES "public"."role_menus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_menus" ADD CONSTRAINT "role_menus_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestion_settings" ADD CONSTRAINT "suggestion_settings_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestion_votes" ADD CONSTRAINT "suggestion_votes_suggestion_id_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."suggestions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_participants" ADD CONSTRAINT "ticket_participants_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_settings" ADD CONSTRAINT "ticket_settings_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appeals_guild_status_created_idx" ON "appeals" USING btree ("guild_id","status","created_at");--> statement-breakpoint
CREATE INDEX "appeals_appellant_created_idx" ON "appeals" USING btree ("guild_id","appellant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "appeals_pending_case_unique" ON "appeals" USING btree ("guild_id","appellant_id","case_id") WHERE "appeals"."status" = 'PENDING' AND "appeals"."case_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "reports_guild_status_created_idx" ON "reports" USING btree ("guild_id","status","created_at");--> statement-breakpoint
CREATE INDEX "reports_reporter_created_idx" ON "reports" USING btree ("guild_id","reporter_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "role_menu_options_menu_role_unique" ON "role_menu_options" USING btree ("menu_id","role_id");--> statement-breakpoint
CREATE INDEX "role_menu_options_menu_position_idx" ON "role_menu_options" USING btree ("menu_id","position");--> statement-breakpoint
CREATE INDEX "role_menus_guild_idx" ON "role_menus" USING btree ("guild_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_menus_guild_message_unique" ON "role_menus" USING btree ("guild_id","message_id");--> statement-breakpoint
CREATE INDEX "suggestions_guild_status_created_idx" ON "suggestions" USING btree ("guild_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "suggestions_guild_message_unique" ON "suggestions" USING btree ("guild_id","message_id");--> statement-breakpoint
CREATE INDEX "tickets_guild_creator_status_idx" ON "tickets" USING btree ("guild_id","creator_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_guild_channel_unique" ON "tickets" USING btree ("guild_id","channel_id");