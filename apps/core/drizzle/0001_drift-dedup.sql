ALTER TABLE "diffs" ADD COLUMN "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "diffs" ADD COLUMN "resolved_at" timestamp with time zone;