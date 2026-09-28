CREATE INDEX "community_events_guild_created_v6_idx" ON "community_events" USING btree ("guild_id","created_at");--> statement-breakpoint
CREATE INDEX "giveaways_guild_created_v6_idx" ON "giveaways" USING btree ("guild_id","created_at");--> statement-breakpoint
CREATE INDEX "member_achievements_guild_awarded_v6_idx" ON "member_achievements" USING btree ("guild_id","awarded_at");--> statement-breakpoint
CREATE INDEX "moderation_cases_guild_created_v6_idx" ON "moderation_cases" USING btree ("guild_id","created_at");--> statement-breakpoint
CREATE INDEX "suggestions_guild_created_v6_idx" ON "suggestions" USING btree ("guild_id","created_at");--> statement-breakpoint
CREATE INDEX "tickets_guild_created_v6_idx" ON "tickets" USING btree ("guild_id","created_at");--> statement-breakpoint
CREATE INDEX "tickets_guild_closed_v6_idx" ON "tickets" USING btree ("guild_id","closed_at");