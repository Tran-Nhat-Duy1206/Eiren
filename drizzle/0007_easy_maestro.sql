ALTER TABLE "giveaway_draws" ADD COLUMN "result_announcement_id" text;--> statement-breakpoint
ALTER TABLE "giveaway_draws" ADD COLUMN "notification_claimed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "giveaway_draws_notice_due_idx" ON "giveaway_draws" USING btree ("result_announcement_id","notification_claimed_at");