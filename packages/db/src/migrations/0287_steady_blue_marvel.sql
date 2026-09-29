CREATE TABLE "ai_provider_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"preset" text DEFAULT 'custom' NOT NULL,
	"wire" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_secret_ref" jsonb,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_provider_connections_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "ai_provider_connections_wire_check" CHECK ("ai_provider_connections"."wire" in ('openai_chat','openai_responses','anthropic','acp')),
	CONSTRAINT "ai_provider_connections_base_url_check" CHECK ("ai_provider_connections"."base_url" ~ '^https?://')
);
--> statement-breakpoint
CREATE TABLE "coordination_room_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"worktree_path" text,
	"branch_name" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coordination_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'open' NOT NULL,
	"transcript_issue_id" uuid,
	"project_id" uuid,
	"repo_full_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"workspace_root_path" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "coordination_rooms_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "coordination_rooms_status_check" CHECK ("coordination_rooms"."status" in ('open','closed'))
);
--> statement-breakpoint
DROP INDEX "environments_name_idx";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "compute_placement" text DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "provider_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "primary_repo_full_name" text;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_provider_connections" ADD CONSTRAINT "ai_provider_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coordination_room_members" ADD CONSTRAINT "coordination_room_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coordination_room_members" ADD CONSTRAINT "coordination_room_members_company_room_fk" FOREIGN KEY ("company_id","room_id") REFERENCES "public"."coordination_rooms"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coordination_room_members" ADD CONSTRAINT "coordination_room_members_company_agent_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coordination_rooms" ADD CONSTRAINT "coordination_rooms_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coordination_rooms" ADD CONSTRAINT "coordination_rooms_transcript_issue_id_issues_id_fk" FOREIGN KEY ("transcript_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coordination_rooms" ADD CONSTRAINT "coordination_rooms_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_provider_connections_company_idx" ON "ai_provider_connections" USING btree ("company_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_provider_connections_company_name_uniq" ON "ai_provider_connections" USING btree ("company_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "coordination_room_members_room_agent_uniq" ON "coordination_room_members" USING btree ("room_id","agent_id");--> statement-breakpoint
CREATE INDEX "coordination_room_members_company_agent_idx" ON "coordination_room_members" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE INDEX "coordination_rooms_company_status_idx" ON "coordination_rooms" USING btree ("company_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "coordination_rooms_company_name_uniq" ON "coordination_rooms" USING btree ("company_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "coordination_rooms_transcript_issue_uniq" ON "coordination_rooms" USING btree ("transcript_issue_id") WHERE "coordination_rooms"."transcript_issue_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_company_provider_connection_fk" FOREIGN KEY ("company_id","provider_connection_id") REFERENCES "public"."ai_provider_connections"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_company_primary_repo_idx" ON "agents" USING btree ("company_id","primary_repo_full_name");--> statement-breakpoint
CREATE INDEX "environments_company_idx" ON "environments" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "environments_company_name_idx" ON "environments" USING btree ("company_id","name") WHERE "environments"."company_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "environments_company_agent_uniq" ON "environments" USING btree ("company_id","agent_id") WHERE "environments"."agent_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "environments_name_idx" ON "environments" USING btree ("name") WHERE "environments"."company_id" IS NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_compute_placement_check" CHECK ("agents"."compute_placement" in ('shared','docker','ssh'));