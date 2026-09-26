ALTER TABLE "community_events" ADD COLUMN "presentation_pending" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "community_events" ADD COLUMN "presentation_retry_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "community_events_presentation_due_idx" ON "community_events" USING btree ("presentation_pending","presentation_retry_at");