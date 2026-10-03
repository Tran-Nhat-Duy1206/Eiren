CREATE TABLE "governance_audit_gaps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"request_id" text NOT NULL,
	"committed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"detected_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "governance_audit_gaps_actor_check" CHECK ("governance_audit_gaps"."actor_user_id" ~ '^[0-9]{17,20}$'),
	CONSTRAINT "governance_audit_gaps_action_check" CHECK ("governance_audit_gaps"."action" IN ('privacy-preview','privacy-confirm','privacy-execute','privacy-deny','retention-confirm','retention-disable','retention-hold-set','retention-hold-clear') AND "governance_audit_gaps"."target_type" = "governance_audit_gaps"."action"),
	CONSTRAINT "governance_audit_gaps_target_check" CHECK ("governance_audit_gaps"."target_id" IS NULL OR "governance_audit_gaps"."target_id" ~ '^[A-Za-z0-9_-]{1,128}$'),
	CONSTRAINT "governance_audit_gaps_request_check" CHECK ("governance_audit_gaps"."request_id" ~ '^[A-Za-z0-9_-]{1,128}$')
);
--> statement-breakpoint
CREATE TABLE "subject_execution_receipts" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"subject_user_id" text NOT NULL,
	"confirmed_by" text NOT NULL,
	"executed_by" text NOT NULL,
	"inventory_hash" text NOT NULL,
	"executed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"outcome" text NOT NULL,
	"request_version" integer NOT NULL,
	"deleted_member_levels" integer NOT NULL,
	"deleted_member_reputation" integer NOT NULL,
	"deleted_achievements" integer NOT NULL,
	"deleted_event_participants" integer NOT NULL,
	"deleted_event_attendance" integer NOT NULL,
	"retained_total" integer NOT NULL,
	CONSTRAINT "subject_execution_receipts_actors_check" CHECK ("subject_execution_receipts"."subject_user_id" ~ '^[0-9]{17,20}$' AND "subject_execution_receipts"."confirmed_by" ~ '^[0-9]{17,20}$' AND "subject_execution_receipts"."executed_by" ~ '^[0-9]{17,20}$'),
	CONSTRAINT "subject_execution_receipts_hash_check" CHECK ("subject_execution_receipts"."inventory_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "subject_execution_receipts_version_check" CHECK ("subject_execution_receipts"."request_version" >= 0),
	CONSTRAINT "subject_execution_receipts_counts_check" CHECK ("subject_execution_receipts"."deleted_member_levels" BETWEEN 0 AND 1 AND "subject_execution_receipts"."deleted_member_reputation" BETWEEN 0 AND 1 AND "subject_execution_receipts"."deleted_achievements" >= 0 AND "subject_execution_receipts"."deleted_event_participants" >= 0 AND "subject_execution_receipts"."deleted_event_attendance" >= 0 AND "subject_execution_receipts"."retained_total" >= 0),
	CONSTRAINT "subject_execution_receipts_outcome_check" CHECK (("subject_execution_receipts"."outcome" = 'COMPLETED' AND "subject_execution_receipts"."retained_total" = 0) OR ("subject_execution_receipts"."outcome" = 'PARTIAL' AND "subject_execution_receipts"."retained_total" > 0))
);
--> statement-breakpoint
CREATE TABLE "subject_request_preview_counts" (
	"preview_id" uuid NOT NULL,
	"disposition" text NOT NULL,
	"category" text NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "subject_request_preview_counts_preview_id_disposition_category_pk" PRIMARY KEY("preview_id","disposition","category"),
	CONSTRAINT "subject_request_preview_counts_disposition_check" CHECK ("subject_request_preview_counts"."disposition" IN ('ERASE','RETAIN')),
	CONSTRAINT "subject_request_preview_counts_category_check" CHECK ("subject_request_preview_counts"."category" IN ('MEMBER_LEVEL_STATE','MEMBER_REPUTATION_AGGREGATE','ACHIEVEMENT_AWARDS','TERMINAL_EVENT_PARTICIPATION','TERMINAL_EVENT_ATTENDANCE','MODERATION_ACCOUNTABILITY','REPORT_APPEAL_EVIDENCE','TICKET_ACCOUNTABILITY','VERIFICATION_ACCESS_STATE','ANTI_ABUSE_OR_REPLAY','REPUTATION_GRANT_HISTORY','SUGGESTION_HISTORY','STARBOARD_HISTORY','EVENT_CREATOR_ACCOUNTABILITY','EVENT_STAFF_ACCOUNTABILITY','ACTIVE_EVENT_STATE','UNRESOLVED_EVENT_PRESENTATION','GIVEAWAY_HISTORY','TEMPVOICE_OPERATIONAL_STATE','ANALYTICS_OPERATIONAL_STATE','GOVERNANCE_AUDIT','RETENTION_GOVERNANCE','AI_ACCOUNTING','AUTOMATION_ACCOUNTABILITY','AUTOMATION_UNCERTAIN','CONFIGURATION_ACCOUNTABILITY','OUT_OF_SCOPE','PRIVACY_GOVERNANCE')),
	CONSTRAINT "subject_request_preview_counts_count_check" CHECK ("subject_request_preview_counts"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "subject_request_previews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"guild_id" text NOT NULL,
	"subject_user_id" text NOT NULL,
	"reviewed_by" text NOT NULL,
	"request_version" integer NOT NULL,
	"inventory_hash" text NOT NULL,
	"eligible_total" integer NOT NULL,
	"retained_total" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "subject_request_previews_actors_check" CHECK ("subject_request_previews"."subject_user_id" ~ '^[0-9]{17,20}$' AND "subject_request_previews"."reviewed_by" ~ '^[0-9]{17,20}$'),
	CONSTRAINT "subject_request_previews_version_check" CHECK ("subject_request_previews"."request_version" >= 0),
	CONSTRAINT "subject_request_previews_hash_check" CHECK ("subject_request_previews"."inventory_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "subject_request_previews_counts_check" CHECK ("subject_request_previews"."eligible_total" >= 0 AND "subject_request_previews"."retained_total" >= 0),
	CONSTRAINT "subject_request_previews_expiry_check" CHECK ("subject_request_previews"."expires_at" > "subject_request_previews"."created_at" AND ("subject_request_previews"."consumed_at" IS NULL OR "subject_request_previews"."consumed_at" >= "subject_request_previews"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "subject_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"subject_user_id" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"requested_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"subject_verified_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"verification_method" text DEFAULT 'SELF_GUILD_MEMBER' NOT NULL,
	"previewed_by" text,
	"previewed_at" timestamp with time zone,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"confirmed_preview_id" uuid,
	"executed_at" timestamp with time zone,
	"denied_by" text,
	"denied_at" timestamp with time zone,
	"denial_code" text,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "subject_requests_guild_id_subject_unique" UNIQUE("guild_id","id","subject_user_id"),
	CONSTRAINT "subject_requests_subject_check" CHECK ("subject_requests"."subject_user_id" ~ '^[0-9]{17,20}$'),
	CONSTRAINT "subject_requests_actors_check" CHECK (("subject_requests"."previewed_by" IS NULL OR "subject_requests"."previewed_by" ~ '^[0-9]{17,20}$') AND
    ("subject_requests"."confirmed_by" IS NULL OR "subject_requests"."confirmed_by" ~ '^[0-9]{17,20}$') AND
    ("subject_requests"."denied_by" IS NULL OR "subject_requests"."denied_by" ~ '^[0-9]{17,20}$')),
	CONSTRAINT "subject_requests_status_check" CHECK ("subject_requests"."status" IN ('PENDING','PREVIEWED','CONFIRMED','EXECUTING','COMPLETED','PARTIAL','DENIED')),
	CONSTRAINT "subject_requests_version_check" CHECK ("subject_requests"."version" >= 0),
	CONSTRAINT "subject_requests_verification_check" CHECK ("subject_requests"."verification_method" = 'SELF_GUILD_MEMBER'),
	CONSTRAINT "subject_requests_denial_code_check" CHECK ("subject_requests"."denial_code" IS NULL OR "subject_requests"."denial_code" IN ('NO_ELIGIBLE_DATA','ACCOUNTABILITY_REQUIRED','ACTIVE_OR_UNRESOLVED_STATE','OUT_OF_SCOPE','POLICY_RETAINED')),
	CONSTRAINT "subject_requests_preview_pair_check" CHECK (("subject_requests"."previewed_by" IS NULL AND "subject_requests"."previewed_at" IS NULL) OR
    ("subject_requests"."previewed_by" IS NOT NULL AND "subject_requests"."previewed_at" IS NOT NULL)),
	CONSTRAINT "subject_requests_confirmation_pair_check" CHECK (("subject_requests"."confirmed_by" IS NULL AND "subject_requests"."confirmed_at" IS NULL AND "subject_requests"."confirmed_preview_id" IS NULL) OR
    ("subject_requests"."confirmed_by" IS NOT NULL AND "subject_requests"."confirmed_at" IS NOT NULL AND "subject_requests"."confirmed_preview_id" IS NOT NULL)),
	CONSTRAINT "subject_requests_denial_pair_check" CHECK (("subject_requests"."denied_by" IS NULL AND "subject_requests"."denied_at" IS NULL AND "subject_requests"."denial_code" IS NULL) OR
    ("subject_requests"."denied_by" IS NOT NULL AND "subject_requests"."denied_at" IS NOT NULL AND "subject_requests"."denial_code" IS NOT NULL)),
	CONSTRAINT "subject_requests_lifecycle_check" CHECK (
    ("subject_requests"."status" = 'PENDING' AND "subject_requests"."previewed_by" IS NULL AND "subject_requests"."confirmed_by" IS NULL AND "subject_requests"."denied_by" IS NULL AND "subject_requests"."executed_at" IS NULL AND "subject_requests"."terminal_at" IS NULL) OR
    ("subject_requests"."status" = 'PREVIEWED' AND "subject_requests"."previewed_by" IS NOT NULL AND "subject_requests"."confirmed_by" IS NULL AND "subject_requests"."denied_by" IS NULL AND "subject_requests"."executed_at" IS NULL AND "subject_requests"."terminal_at" IS NULL) OR
    ("subject_requests"."status" IN ('CONFIRMED','EXECUTING') AND "subject_requests"."previewed_by" IS NOT NULL AND "subject_requests"."confirmed_by" IS NOT NULL AND "subject_requests"."denied_by" IS NULL AND "subject_requests"."executed_at" IS NULL AND "subject_requests"."terminal_at" IS NULL) OR
    ("subject_requests"."status" IN ('COMPLETED','PARTIAL') AND "subject_requests"."previewed_by" IS NOT NULL AND "subject_requests"."confirmed_by" IS NOT NULL AND "subject_requests"."denied_by" IS NULL AND "subject_requests"."executed_at" IS NOT NULL AND "subject_requests"."terminal_at" IS NOT NULL) OR
    ("subject_requests"."status" = 'DENIED' AND "subject_requests"."denied_by" IS NOT NULL AND "subject_requests"."executed_at" IS NULL AND "subject_requests"."terminal_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "governance_audit_gaps" ADD CONSTRAINT "governance_audit_gaps_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_execution_receipts" ADD CONSTRAINT "subject_execution_receipts_request_subject_fk" FOREIGN KEY ("guild_id","request_id","subject_user_id") REFERENCES "public"."subject_requests"("guild_id","id","subject_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_request_preview_counts" ADD CONSTRAINT "subject_request_preview_counts_preview_fk" FOREIGN KEY ("preview_id") REFERENCES "public"."subject_request_previews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_request_previews" ADD CONSTRAINT "subject_request_previews_request_subject_fk" FOREIGN KEY ("guild_id","request_id","subject_user_id") REFERENCES "public"."subject_requests"("guild_id","id","subject_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_requests" ADD CONSTRAINT "subject_requests_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "governance_audit_gaps_guild_recent_idx" ON "governance_audit_gaps" USING btree ("guild_id","detected_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "governance_audit_gaps_time_idx" ON "governance_audit_gaps" USING btree ("detected_at");--> statement-breakpoint
CREATE INDEX "subject_execution_receipts_guild_recent_idx" ON "subject_execution_receipts" USING btree ("guild_id","executed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "subject_execution_receipts_time_idx" ON "subject_execution_receipts" USING btree ("executed_at");--> statement-breakpoint
CREATE INDEX "subject_request_previews_request_recent_idx" ON "subject_request_previews" USING btree ("guild_id","request_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "subject_request_previews_expiry_idx" ON "subject_request_previews" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "subject_request_previews_consumed_idx" ON "subject_request_previews" USING btree ("consumed_at") WHERE "subject_request_previews"."consumed_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "subject_requests_active_subject_unique" ON "subject_requests" USING btree ("guild_id","subject_user_id") WHERE "subject_requests"."status" IN ('PENDING','PREVIEWED','CONFIRMED','EXECUTING');--> statement-breakpoint
CREATE INDEX "subject_requests_guild_recent_idx" ON "subject_requests" USING btree ("guild_id","requested_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "subject_requests_subject_latest_idx" ON "subject_requests" USING btree ("guild_id","subject_user_id","requested_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "subject_requests_terminal_expiry_idx" ON "subject_requests" USING btree ("terminal_at","id") WHERE "subject_requests"."terminal_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "event_attendance_subject_user_idx" ON "event_attendance" USING btree ("user_id","event_id");--> statement-breakpoint
CREATE INDEX "event_attendance_subject_marked_by_idx" ON "event_attendance" USING btree ("marked_by","event_id");--> statement-breakpoint
CREATE INDEX "event_participants_subject_user_idx" ON "event_participants" USING btree ("user_id","event_id");--> statement-breakpoint
CREATE INDEX "giveaway_entries_subject_user_idx" ON "giveaway_entries" USING btree ("user_id","giveaway_id");--> statement-breakpoint
CREATE INDEX "giveaway_winners_subject_user_idx" ON "giveaway_winners" USING btree ("user_id","giveaway_id");--> statement-breakpoint
CREATE INDEX "suggestion_votes_subject_user_idx" ON "suggestion_votes" USING btree ("user_id","suggestion_id");--> statement-breakpoint
CREATE INDEX "ticket_participants_subject_user_idx" ON "ticket_participants" USING btree ("user_id","ticket_id");--> statement-breakpoint
CREATE INDEX "ticket_participants_subject_added_by_idx" ON "ticket_participants" USING btree ("added_by","ticket_id");