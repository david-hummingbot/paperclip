DROP INDEX "environments_local_driver_idx";--> statement-breakpoint
DROP INDEX "environments_name_idx";--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "environments_company_idx" ON "environments" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "environments_company_local_driver_idx" ON "environments" USING btree ("company_id","driver") WHERE "environments"."driver" = 'local' AND "environments"."company_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "environments_company_name_idx" ON "environments" USING btree ("company_id","name") WHERE "environments"."company_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "environments_company_agent_uniq" ON "environments" USING btree ("company_id","agent_id") WHERE "environments"."agent_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "environments_local_driver_idx" ON "environments" USING btree ("driver") WHERE "environments"."driver" = 'local' AND "environments"."company_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "environments_name_idx" ON "environments" USING btree ("name") WHERE "environments"."company_id" IS NULL;