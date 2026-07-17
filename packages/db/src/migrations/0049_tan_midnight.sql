CREATE TABLE "file_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"server_id" text,
	"operation_type" text NOT NULL,
	"operation_scope" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "file_operations" ADD CONSTRAINT "file_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_operations_status_server_idx" ON "file_operations" USING btree ("status","server_id");--> statement-breakpoint
CREATE INDEX "file_operations_company_idx" ON "file_operations" USING btree ("company_id");