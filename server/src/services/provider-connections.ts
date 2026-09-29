import { and, asc, eq } from "drizzle-orm";
import { agents, aiProviderConnections, type Db } from "@paperclipai/db";
import {
  PROVIDER_PRESET_DEFINITIONS,
  isLoopbackProviderBaseUrl,
  type CreateProviderConnection,
  type ProviderConnection,
  type UpdateProviderConnection,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

type ConnectionRow = typeof aiProviderConnections.$inferSelect;

/**
 * Maps a stored row to the API shape. The API key is never returned, only
 * whether one is set: the row holds a secret *reference*, and echoing even the
 * reference invites a client to treat it as a handle it can pass around.
 */
function toConnection(row: ConnectionRow): ProviderConnection {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    preset: row.preset,
    wire: row.wire,
    baseUrl: row.baseUrl,
    hasApiKey: row.apiKeySecretRef !== null && row.apiKeySecretRef !== undefined,
    headers: row.headers ?? {},
    models: row.models ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Trailing slashes make `new URL("chat/completions", base)` silently drop the
 * last path segment, so a base stored as `…/v1/` and one stored as `…/v1`
 * would resolve differently. Normalise once on write.
 */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * A keyless endpoint is legitimate — a local model server wants no auth — but
 * a *remote* keyless endpoint is nearly always a mistake, so it is refused
 * rather than silently sending unauthenticated requests to a third party.
 */
function assertKeyPresenceIsPlausible(input: {
  baseUrl: string;
  hasApiKey: boolean;
  preset: CreateProviderConnection["preset"];
}) {
  if (input.hasApiKey) return;
  if (isLoopbackProviderBaseUrl(input.baseUrl)) return;
  // `custom` carries no preset expectation, so a keyless custom endpoint is
  // the operator's call.
  if (input.preset === "custom") return;
  const definition = PROVIDER_PRESET_DEFINITIONS[input.preset];
  if (definition?.requiresApiKey) {
    throw unprocessable(`${definition.label} requires an API key.`, {
      code: "provider_connection_key_required",
    });
  }
}

export function providerConnectionService(db: Db) {
  async function requireRow(companyId: string, id: string): Promise<ConnectionRow> {
    const row = await db
      .select()
      .from(aiProviderConnections)
      .where(and(eq(aiProviderConnections.companyId, companyId), eq(aiProviderConnections.id, id)))
      .then((rows) => rows[0] ?? null);
    // Company-scoped lookup, so another company's id is indistinguishable from
    // one that does not exist.
    if (!row) throw notFound("Provider connection not found");
    return row;
  }

  return {
    list: async (companyId: string): Promise<ProviderConnection[]> => {
      const rows = await db
        .select()
        .from(aiProviderConnections)
        .where(eq(aiProviderConnections.companyId, companyId))
        .orderBy(asc(aiProviderConnections.name));
      return rows.map(toConnection);
    },

    getById: async (companyId: string, id: string): Promise<ProviderConnection> =>
      toConnection(await requireRow(companyId, id)),

    create: async (
      companyId: string,
      input: CreateProviderConnection,
    ): Promise<ProviderConnection> => {
      const baseUrl = normalizeBaseUrl(input.baseUrl);
      assertKeyPresenceIsPlausible({
        baseUrl,
        hasApiKey: input.apiKeySecretRef !== null,
        preset: input.preset,
      });
      const [row] = await db
        .insert(aiProviderConnections)
        .values({
          companyId,
          name: input.name,
          preset: input.preset,
          wire: input.wire,
          baseUrl,
          apiKeySecretRef: input.apiKeySecretRef,
          headers: input.headers,
          models: input.models,
        })
        .onConflictDoNothing({
          target: [aiProviderConnections.companyId, aiProviderConnections.name],
        })
        .returning();
      if (!row) {
        throw conflict(`A provider connection named "${input.name}" already exists.`, {
          code: "provider_connection_name_taken",
        });
      }
      return toConnection(row);
    },

    update: async (
      companyId: string,
      id: string,
      input: UpdateProviderConnection,
    ): Promise<ProviderConnection> => {
      const existing = await requireRow(companyId, id);
      const baseUrl =
        input.baseUrl === undefined ? existing.baseUrl : normalizeBaseUrl(input.baseUrl);
      const hasApiKey =
        input.apiKeySecretRef === undefined
          ? existing.apiKeySecretRef !== null
          : input.apiKeySecretRef !== null;
      assertKeyPresenceIsPlausible({
        baseUrl,
        hasApiKey,
        preset: input.preset ?? existing.preset,
      });
      const [row] = await db
        .update(aiProviderConnections)
        .set({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.preset === undefined ? {} : { preset: input.preset }),
          ...(input.wire === undefined ? {} : { wire: input.wire }),
          ...(input.baseUrl === undefined ? {} : { baseUrl }),
          ...(input.apiKeySecretRef === undefined
            ? {}
            : { apiKeySecretRef: input.apiKeySecretRef }),
          ...(input.headers === undefined ? {} : { headers: input.headers }),
          ...(input.models === undefined ? {} : { models: input.models }),
          updatedAt: new Date(),
        })
        .where(
          and(eq(aiProviderConnections.companyId, companyId), eq(aiProviderConnections.id, id)),
        )
        .returning();
      if (!row) throw notFound("Provider connection not found");
      return toConnection(row);
    },

    remove: async (companyId: string, id: string): Promise<{ detachedAgentIds: string[] }> => {
      await requireRow(companyId, id);
      // The composite foreign key carries no ON DELETE action, because `set
      // null` on a composite key would also null `agents.company_id`. Detach
      // the agents explicitly, in the same transaction as the delete, so a
      // bound agent can never be left pointing at a row that is gone — and
      // report which agents lost their provider instead of leaving them
      // silently unconfigured.
      return db.transaction(async (tx) => {
        const detached = await tx
          .update(agents)
          .set({ providerConnectionId: null, updatedAt: new Date() })
          .where(and(eq(agents.companyId, companyId), eq(agents.providerConnectionId, id)))
          .returning({ id: agents.id });
        await tx
          .delete(aiProviderConnections)
          .where(
            and(eq(aiProviderConnections.companyId, companyId), eq(aiProviderConnections.id, id)),
          );
        return { detachedAgentIds: detached.map((row) => row.id) };
      });
    },
  };
}

export type ProviderConnectionService = ReturnType<typeof providerConnectionService>;
