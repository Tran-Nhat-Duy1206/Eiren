ALTER TABLE "automation_action_runs" ADD COLUMN "dispatch_token" uuid;--> statement-breakpoint
ALTER TABLE "automation_action_runs" ADD COLUMN "reconciliation_result" text;--> statement-breakpoint
ALTER TABLE "automation_action_runs" ADD COLUMN "reconciled_by" text;--> statement-breakpoint
ALTER TABLE "automation_action_runs" ADD COLUMN "reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automation_action_runs" ADD CONSTRAINT "automation_action_runs_reconciliation_check" CHECK (("automation_action_runs"."reconciliation_result" IS NULL AND "automation_action_runs"."reconciled_by" IS NULL AND "automation_action_runs"."reconciled_at" IS NULL) OR
    ("automation_action_runs"."reconciliation_result" IN ('CONFIRMED_SENT','CONFIRMED_NOT_SENT') AND "automation_action_runs"."reconciled_by" ~ '^[0-9]{17,20}$' AND "automation_action_runs"."reconciled_at" IS NOT NULL));