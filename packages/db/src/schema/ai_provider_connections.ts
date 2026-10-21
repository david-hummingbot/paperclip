import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ProviderPreset, ProviderWireFormat } from "@paperclipai/shared";
import { companies } from "./companies.js";

/**
 * A company-scoped provider endpoint: a wire format, a base URL, and an
 * optional key held in the company secret store.
 *
 * This is deliberately a table rather than another value in the four-provider
 * union that `ai_connection_defaults` checks in SQL. That union exists to
 * describe *subscription* logins (an OAuth session against a vendor account),
 * which stay as they are. An API-key-plus-base-URL endpoint is a different
 * thing, and encoding it as an enum is what forced every other vendor through
 * the undocumented per-harness env hatches.
 *
 * The key is a reference into `company_secrets`, never a literal, so a read of
 * this table can be returned to the board without redaction.
 */
export const aiProviderConnections = pgTable(
  "ai_provider_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    preset: text("preset").$type<ProviderPreset>().notNull().default("custom"),
    wire: text("wire").$type<ProviderWireFormat>().notNull(),
    baseUrl: text("base_url").notNull(),
    /** `{ type: "secret_ref", secretId, version }`, or null for a keyless endpoint. */
    apiKeySecretRef: jsonb("api_key_secret_ref").$type<Record<string, unknown> | null>(),
    /** Operator-supplied non-auth headers, merged over the preset's defaults. */
    headers: jsonb("headers").$type<Record<string, string>>().notNull().default({}),
    /** Static model ids for endpoints without usable discovery. */
    models: jsonb("models").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("ai_provider_connections_company_idx").on(table.companyId, table.updatedAt),
    // Names are how an operator picks a connection on the agent form, so they
    // are unique per company. Scoped to the company, never instance-wide.
    companyNameIdx: uniqueIndex("ai_provider_connections_company_name_uniq").on(
      table.companyId,
      table.name,
    ),
    // Company-scoped compound key so a referencing row can carry a composite
    // foreign key and be unable to point at another company's connection.
    companyIdUq: unique("ai_provider_connections_company_id_uq").on(
      table.companyId,
      table.id,
    ),
    wireCheck: check(
      "ai_provider_connections_wire_check",
      sql`${table.wire} in ('openai_chat','openai_responses','anthropic','acp')`,
    ),
    // Shape only. Loopback and private addresses are explicitly allowed: a
    // local model server lives on 127.0.0.1 and a Docker agent reaches its
    // host at host.docker.internal.
    baseUrlCheck: check(
      "ai_provider_connections_base_url_check",
      sql`${table.baseUrl} ~ '^https?://'`,
    ),
  }),
);
