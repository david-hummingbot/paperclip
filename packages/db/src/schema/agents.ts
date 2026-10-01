import type { AgentAppearance } from "@paperclipai/shared";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  check,
  foreignKey,
  index,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { environments } from "./environments.js";
import { aiProviderConnections } from "./ai_provider_connections.js";

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    role: text("role").notNull().default("general"),
    title: text("title"),
    icon: text("icon"),
    appearance: jsonb("appearance").$type<AgentAppearance>(),
    status: text("status").notNull().default("idle"),
    reportsTo: uuid("reports_to").references((): AnyPgColumn => agents.id),
    capabilities: text("capabilities"),
    adapterType: text("adapter_type").notNull().default("process"),
    adapterConfig: jsonb("adapter_config").$type<Record<string, unknown>>().notNull().default({}),
    runtimeConfig: jsonb("runtime_config").$type<Record<string, unknown>>().notNull().default({}),
    defaultEnvironmentId: uuid("default_environment_id").references(() => environments.id, { onDelete: "set null" }),
    /**
     * Where this agent's runs execute. `shared` uses the project cwd on the
     * Paperclip host (today's behaviour, and the default so existing agents
     * are unchanged). `docker` and `ssh` mean the agent owns a machine, named
     * by `defaultEnvironmentId`, whose `environments` row carries this agent's
     * id. Placement is independent of which model the agent talks to.
     */
    computePlacement: text("compute_placement").notNull().default("shared"),
    /**
     * The provider endpoint this agent uses, when it uses a provider
     * connection rather than a subscription-based managed AI connection. The
     * composite foreign key makes a cross-company reference impossible.
     */
    providerConnectionId: uuid("provider_connection_id"),
    /**
     * The GitHub repository this agent owns review for, as `owner/name`.
     * Review for that repo wakes this agent on its own session and its own
     * computer; it does not require a coordination room.
     */
    primaryRepoFullName: text("primary_repo_full_name"),
    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    spentMonthlyCents: integer("spent_monthly_cents").notNull().default(0),
    pauseReason: text("pause_reason"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    errorReason: text("error_reason"),
    permissions: jsonb("permissions").$type<Record<string, unknown>>().notNull().default({}),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdUq: unique("agents_company_id_uq").on(table.companyId, table.id),
    companyStatusIdx: index("agents_company_status_idx").on(table.companyId, table.status),
    companyReportsToIdx: index("agents_company_reports_to_idx").on(table.companyId, table.reportsTo),
    companyDefaultEnvironmentIdx: index("agents_company_default_environment_idx").on(table.companyId, table.defaultEnvironmentId),
    // Unique per company, not just indexed: "which agent owns this repo" has to
    // have one answer. Two agents claiming the same repo would make room member
    // seeding pick both and leave review ownership undefined. Partial, so the
    // many agents with no primary repo do not collide with each other.
    companyPrimaryRepoUq: uniqueIndex("agents_company_primary_repo_uniq")
      .on(table.companyId, table.primaryRepoFullName)
      .where(sql`${table.primaryRepoFullName} is not null`),
    computePlacementCheck: check(
      "agents_compute_placement_check",
      sql`${table.computePlacement} in ('shared','docker','ssh')`,
    ),
    // No ON DELETE action: this is a composite key and `set null` would null
    // `company_id` too, which is NOT NULL. The provider-connection service
    // clears `providerConnectionId` in the same transaction as the delete.
    providerConnectionFk: foreignKey({
      columns: [table.companyId, table.providerConnectionId],
      foreignColumns: [aiProviderConnections.companyId, aiProviderConnections.id],
      name: "agents_company_provider_connection_fk",
    }),
  }),
);
