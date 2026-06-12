CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dependency_id" uuid NOT NULL,
	"diff_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "baselines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dependency_id" uuid NOT NULL,
	"schema" jsonb NOT NULL,
	"sample_count" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"locked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'rest' NOT NULL,
	"url" text NOT NULL,
	"method" text DEFAULT 'GET' NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"poll_interval_seconds" integer DEFAULT 300 NOT NULL,
	"baseline_window" integer DEFAULT 5 NOT NULL,
	"alert_threshold" text DEFAULT 'WARNING' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dependency_id" uuid NOT NULL,
	"baseline_id" uuid NOT NULL,
	"entries" jsonb NOT NULL,
	"severity" text NOT NULL,
	"captured_schema" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dependency_id" uuid NOT NULL,
	"body" jsonb NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_dependency_id_dependencies_id_fk" FOREIGN KEY ("dependency_id") REFERENCES "public"."dependencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_diff_id_diffs_id_fk" FOREIGN KEY ("diff_id") REFERENCES "public"."diffs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baselines" ADD CONSTRAINT "baselines_dependency_id_dependencies_id_fk" FOREIGN KEY ("dependency_id") REFERENCES "public"."dependencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diffs" ADD CONSTRAINT "diffs_dependency_id_dependencies_id_fk" FOREIGN KEY ("dependency_id") REFERENCES "public"."dependencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diffs" ADD CONSTRAINT "diffs_baseline_id_baselines_id_fk" FOREIGN KEY ("baseline_id") REFERENCES "public"."baselines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_dependency_id_dependencies_id_fk" FOREIGN KEY ("dependency_id") REFERENCES "public"."dependencies"("id") ON DELETE cascade ON UPDATE no action;