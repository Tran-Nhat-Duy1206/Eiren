-- Existing 0015 installations may contain manually misattributed attempt metadata.
-- Reassign it to the authoritative execution guild before enforcing the composite FK.
CREATE UNIQUE INDEX "automation_executions_guild_id_unique" ON "automation_executions" USING btree ("guild_id","id");--> statement-breakpoint
UPDATE "automation_execution_attempts" a SET "guild_id" = e."guild_id"
FROM "automation_executions" e
WHERE a."execution_id" = e."id" AND a."guild_id" <> e."guild_id";--> statement-breakpoint
ALTER TABLE "automation_execution_attempts" ADD CONSTRAINT "automation_execution_attempts_guild_execution_fk" FOREIGN KEY ("guild_id","execution_id") REFERENCES "public"."automation_executions"("guild_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- On already-applied 0015 databases, align the check with the corrected legacy-inert backfill.
ALTER TABLE "automation_execution_actions" DROP CONSTRAINT "automation_execution_actions_kind_check";--> statement-breakpoint
ALTER TABLE "automation_execution_actions" ADD CONSTRAINT "automation_execution_actions_kind_check" CHECK ("automation_execution_actions"."action_key" IN ('STATIC_MESSAGE','STAFF_LOG','LEGACY_INERT') AND "automation_execution_actions"."action_version" BETWEEN 1 AND 100);--> statement-breakpoint
-- Already-applied 0015 may have misidentified legacy runs using then-current action JSON.
-- V7.3 has no action-run writer: all existing run-bound snapshots lack proven provenance.
-- Replace those snapshots with the same non-runnable marker as the corrected 0015 backfill.
DROP TRIGGER "automation_execution_actions_immutable" ON "automation_execution_actions";--> statement-breakpoint
UPDATE "automation_execution_actions" s
SET "action_key" = 'LEGACY_INERT', "action_version" = 1, "config" = '{"provenance":"V7_1_UNVERIFIED"}'::jsonb
FROM "automation_action_runs" r
WHERE s."execution_id" = r."execution_id" AND s."position" = r."position";--> statement-breakpoint
CREATE TRIGGER automation_execution_actions_immutable BEFORE UPDATE ON automation_execution_actions
FOR EACH ROW EXECUTE FUNCTION automation_execution_actions_reject_update();
