CREATE TABLE "automation_execution_actions" (
	"execution_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"action_key" text NOT NULL,
	"action_version" integer NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "automation_execution_actions_execution_id_position_pk" PRIMARY KEY("execution_id","position"),
	CONSTRAINT "automation_execution_actions_position_check" CHECK ("automation_execution_actions"."position" BETWEEN 0 AND 1),
	CONSTRAINT "automation_execution_actions_kind_check" CHECK ("automation_execution_actions"."action_key" IN ('STATIC_MESSAGE','STAFF_LOG','LEGACY_INERT') AND "automation_execution_actions"."action_version" BETWEEN 1 AND 100),
	CONSTRAINT "automation_execution_actions_config_check" CHECK (jsonb_typeof("automation_execution_actions"."config") = 'object' AND octet_length("automation_execution_actions"."config"::text) <= 2048 AND
    ("automation_execution_actions"."action_key" <> 'STATIC_MESSAGE' OR length(coalesce("automation_execution_actions"."config"->>'text', '')) <= 1000))
);
--> statement-breakpoint
CREATE TABLE "automation_execution_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"execution_id" uuid NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automation_execution_actions" ADD CONSTRAINT "automation_execution_actions_execution_id_automation_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."automation_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_execution_attempts" ADD CONSTRAINT "automation_execution_attempts_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_execution_attempts" ADD CONSTRAINT "automation_execution_attempts_execution_id_automation_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."automation_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_execution_attempts_guild_time_idx" ON "automation_execution_attempts" USING btree ("guild_id","attempted_at");--> statement-breakpoint
CREATE INDEX "automation_execution_attempts_time_idx" ON "automation_execution_attempts" USING btree ("attempted_at");--> statement-breakpoint
-- V7.1 action-run positions were not bound to current actions and had NO executor.
-- Historical action/config provenance cannot be reconstructed after a rule edit. Preserve
-- every inert run with an explicit, non-runnable sentinel, never mislabel it with live JSON.
-- The typed registry has no LEGACY_INERT definition; final authorization fails closed.
INSERT INTO "automation_execution_actions" ("execution_id", "position", "action_key", "action_version", "config")
SELECT ar."execution_id", ar."position", 'LEGACY_INERT', 1, '{"provenance":"V7_1_UNVERIFIED"}'::jsonb
FROM "automation_action_runs" ar;--> statement-breakpoint
ALTER TABLE "automation_action_runs" ADD CONSTRAINT "automation_action_runs_snapshot_fk" FOREIGN KEY ("execution_id","position") REFERENCES "public"."automation_execution_actions"("execution_id","position") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Once queued, an action definition must never be rewritten; execution deletion still cascades snapshots.
CREATE FUNCTION automation_execution_actions_reject_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'automation execution action snapshots are immutable';
END;
$$;--> statement-breakpoint
CREATE TRIGGER automation_execution_actions_immutable BEFORE UPDATE ON automation_execution_actions
FOR EACH ROW EXECUTE FUNCTION automation_execution_actions_reject_update();