CREATE TABLE "retention_policies" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"ticket_retention_days" integer DEFAULT 90 NOT NULL,
	"report_retention_days" integer DEFAULT 365 NOT NULL,
	"appeal_retention_days" integer DEFAULT 365 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_policies_days_check" CHECK ("retention_policies"."ticket_retention_days" BETWEEN 30 AND 365 AND "retention_policies"."report_retention_days" BETWEEN 90 AND 730 AND "retention_policies"."appeal_retention_days" BETWEEN 90 AND 730),
	CONSTRAINT "retention_policies_version_check" CHECK ("retention_policies"."version" >= 0),
	CONSTRAINT "retention_policies_confirmation_check" CHECK (("retention_policies"."confirmed_by" IS NULL) = ("retention_policies"."confirmed_at" IS NULL) AND (NOT "retention_policies"."enabled" OR "retention_policies"."confirmed_by" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "retention_previews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"ticket_days" integer NOT NULL,
	"report_days" integer NOT NULL,
	"appeal_days" integer NOT NULL,
	"eligible_ticket_count" integer NOT NULL,
	"eligible_report_count" integer NOT NULL,
	"eligible_appeal_count" integer NOT NULL,
	"base_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "retention_previews_days_check" CHECK ("retention_previews"."ticket_days" BETWEEN 30 AND 365 AND "retention_previews"."report_days" BETWEEN 90 AND 730 AND "retention_previews"."appeal_days" BETWEEN 90 AND 730),
	CONSTRAINT "retention_previews_counts_check" CHECK ("retention_previews"."eligible_ticket_count" >= 0 AND "retention_previews"."eligible_report_count" >= 0 AND "retention_previews"."eligible_appeal_count" >= 0),
	CONSTRAINT "retention_previews_version_check" CHECK ("retention_previews"."base_version" >= 0),
	CONSTRAINT "retention_previews_expiry_check" CHECK ("retention_previews"."expires_at" > "retention_previews"."created_at" AND ("retention_previews"."consumed_at" IS NULL OR "retention_previews"."consumed_at" >= "retention_previews"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "retention_receipts" (
	"guild_id" text NOT NULL,
	"domain" text NOT NULL,
	"record_id" bigint NOT NULL,
	"policy_version" integer NOT NULL,
	"policy_authorizer_id" text NOT NULL,
	"redacted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_receipts_domain_check" CHECK ("retention_receipts"."domain" IN ('TICKET','REPORT','APPEAL')),
	CONSTRAINT "retention_receipts_version_check" CHECK ("retention_receipts"."policy_version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "appeals" ALTER COLUMN "reason" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ALTER COLUMN "description" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "appeals" ADD COLUMN "narrative_redacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appeals" ADD COLUMN "narrative_retention_policy_version" integer;--> statement-breakpoint
ALTER TABLE "appeals" ADD COLUMN "retention_hold" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "appeals" ADD COLUMN "retention_hold_by" text;--> statement-breakpoint
ALTER TABLE "appeals" ADD COLUMN "retention_hold_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "narrative_redacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "narrative_retention_policy_version" integer;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "retention_hold" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "retention_hold_by" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "retention_hold_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "transcript_redacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "transcript_retention_policy_version" integer;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "retention_hold" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "retention_hold_by" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "retention_hold_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_previews" ADD CONSTRAINT "retention_previews_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_receipts" ADD CONSTRAINT "retention_receipts_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "retention_previews_expiry_idx" ON "retention_previews" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "retention_receipts_record_unique" ON "retention_receipts" USING btree ("guild_id","domain","record_id");--> statement-breakpoint
CREATE INDEX "retention_receipts_expiry_idx" ON "retention_receipts" USING btree ("redacted_at");--> statement-breakpoint
CREATE INDEX "appeals_retention_eligible_idx" ON "appeals" USING btree ("guild_id","reviewed_at") WHERE "appeals"."status" IN ('ACCEPTED','REJECTED') AND "appeals"."reason" IS NOT NULL AND "appeals"."narrative_redacted_at" IS NULL AND NOT "appeals"."retention_hold";--> statement-breakpoint
CREATE INDEX "reports_retention_eligible_idx" ON "reports" USING btree ("guild_id","closed_at") WHERE "reports"."status" = 'CLOSED' AND "reports"."description" IS NOT NULL AND "reports"."narrative_redacted_at" IS NULL AND NOT "reports"."retention_hold";--> statement-breakpoint
CREATE INDEX "tickets_retention_eligible_idx" ON "tickets" USING btree ("guild_id","closed_at") WHERE "tickets"."status" = 'CLOSED' AND "tickets"."transcript" IS NOT NULL AND "tickets"."transcript_redacted_at" IS NULL AND NOT "tickets"."retention_hold";--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_retention_hold_check" CHECK ((NOT "appeals"."retention_hold" AND "appeals"."retention_hold_by" IS NULL AND "appeals"."retention_hold_at" IS NULL) OR ("appeals"."retention_hold" AND "appeals"."retention_hold_by" IS NOT NULL AND "appeals"."retention_hold_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_retention_narrative_check" CHECK (("appeals"."narrative_redacted_at" IS NULL AND "appeals"."narrative_retention_policy_version" IS NULL AND "appeals"."reason" IS NOT NULL) OR ("appeals"."narrative_redacted_at" IS NOT NULL AND "appeals"."narrative_retention_policy_version" >= 0 AND "appeals"."reason" IS NULL));--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_retention_hold_check" CHECK ((NOT "reports"."retention_hold" AND "reports"."retention_hold_by" IS NULL AND "reports"."retention_hold_at" IS NULL) OR ("reports"."retention_hold" AND "reports"."retention_hold_by" IS NOT NULL AND "reports"."retention_hold_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_retention_narrative_check" CHECK (("reports"."narrative_redacted_at" IS NULL AND "reports"."narrative_retention_policy_version" IS NULL AND "reports"."description" IS NOT NULL) OR ("reports"."narrative_redacted_at" IS NOT NULL AND "reports"."narrative_retention_policy_version" >= 0 AND "reports"."description" IS NULL));--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_retention_hold_check" CHECK ((NOT "tickets"."retention_hold" AND "tickets"."retention_hold_by" IS NULL AND "tickets"."retention_hold_at" IS NULL) OR ("tickets"."retention_hold" AND "tickets"."retention_hold_by" IS NOT NULL AND "tickets"."retention_hold_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_retention_redaction_check" CHECK (("tickets"."transcript_redacted_at" IS NULL AND "tickets"."transcript_retention_policy_version" IS NULL) OR ("tickets"."transcript_redacted_at" IS NOT NULL AND "tickets"."transcript_retention_policy_version" >= 0 AND "tickets"."transcript" IS NULL));