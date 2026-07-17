DROP INDEX "board_api_keys_key_hash_idx";--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "server_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "board_api_keys_key_hash_idx" ON "board_api_keys" USING btree ("key_hash");