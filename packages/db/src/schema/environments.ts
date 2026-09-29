import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const environments = pgTable(
  "environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    driver: text("driver").notNull().default("local"),
    status: text("status").notNull().default("active"),
    /**
     * Owning company, or null for an instance-level environment. Upstream
     * `environments` is instance-level throughout, so existing rows stay null
     * and keep working; a dedicated per-agent computer (Docker or SSH) sets
     * this so another company can never select the same host, image, or key.
     */
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    /**
     * Owning agent, for an environment that is one agent's computer. Null for
     * a shared or instance-level environment. Set together with `companyId`;
     * `environments_company_agent_uniq` keeps it to one computer per agent.
     *
     * Deliberately not a foreign key to `agents`: `agents.defaultEnvironmentId`
     * already points the other way, and a second FK would make the two tables
     * mutually dependent and the delete order ambiguous. Ownership is enforced
     * in the environments service, which nulls this on agent deletion.
     */
    agentId: uuid("agent_id"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    envVars: jsonb("env_vars").$type<Record<string, unknown>>().notNull().default({}),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index("environments_status_idx").on(table.status),
    companyIdx: index("environments_company_idx").on(table.companyId, table.status),
    // One `local` environment per owner. Upstream allowed exactly one
    // instance-wide; that stays true for the instance-level row (company_id is
    // null) and each company may now hold its own.
    localDriverIdx: uniqueIndex("environments_local_driver_idx")
      .on(table.driver)
      .where(sql`${table.driver} = 'local' AND ${table.companyId} IS NULL`),
    companyLocalDriverIdx: uniqueIndex("environments_company_local_driver_idx")
      .on(table.companyId, table.driver)
      .where(sql`${table.driver} = 'local' AND ${table.companyId} IS NOT NULL`),
    managedSandboxIdx: uniqueIndex("environments_managed_sandbox_idx")
      .on(table.driver)
      .where(
        sql`${table.driver} = 'sandbox' AND (${table.metadata} ->> 'managedByPaperclip')::boolean = true`,
      ),
    // Names are unique per owner rather than instance-wide. The old global
    // unique index made two companies unable to hold an environment of the
    // same name, which per-agent computers hit immediately (two companies with
    // an agent called `condor`). A null `companyId` compares as distinct in a
    // plain unique index, so the instance-level scope needs its own partial.
    nameIdx: uniqueIndex("environments_name_idx")
      .on(table.name)
      .where(sql`${table.companyId} IS NULL`),
    companyNameIdx: uniqueIndex("environments_company_name_idx")
      .on(table.companyId, table.name)
      .where(sql`${table.companyId} IS NOT NULL`),
    // An agent owns at most one computer.
    companyAgentIdx: uniqueIndex("environments_company_agent_uniq")
      .on(table.companyId, table.agentId)
      .where(sql`${table.agentId} IS NOT NULL`),
  }),
);
