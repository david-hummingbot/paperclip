import { and, eq } from "drizzle-orm";
import { agents, aiProviderConnections, type Db } from "@paperclipai/db";
import { PROVIDER_PRESET_DEFINITIONS } from "@paperclipai/shared";
import { secretService } from "./secrets.js";
import { logger } from "../middleware/logger.js";

/**
 * The provider endpoint handed to an adapter for one run.
 *
 * `apiKey` is the resolved secret value. It exists only for the lifetime of
 * the run's config object and is never persisted or logged — the same
 * treatment every other adapter credential gets.
 */
export interface RuntimeProviderConnection {
  id: string;
  name: string;
  wire: string;
  baseUrl: string;
  apiKey: string | null;
  headers: Record<string, string>;
  models: string[];
}

/** The runtime-config key the adapter reads. */
export const PROVIDER_CONNECTION_CONFIG_KEY = "paperclipProviderConnection";

function asSecretRef(
  value: unknown,
): { secretId: string; version: number | "latest" } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "secret_ref") return null;
  const secretId = typeof record.secretId === "string" ? record.secretId : null;
  if (!secretId) return null;
  const version =
    typeof record.version === "number" || record.version === "latest"
      ? (record.version as number | "latest")
      : "latest";
  return { secretId, version };
}

/**
 * Resolves the provider connection bound to an agent, if it has one.
 *
 * Returns null when the agent uses a subscription-based managed AI connection
 * or a CLI harness with its own credentials — those paths are unchanged and
 * must not see this key.
 *
 * A connection whose key cannot be resolved returns the connection with a null
 * key rather than throwing: the adapter then reports a clear
 * `provider_unauthorized` from the endpoint's own refusal, which tells the
 * operator more than a secret-store stack trace would.
 */
export async function resolveAgentProviderConnection(
  db: Db,
  input: { companyId: string; agentId: string; runId: string },
): Promise<RuntimeProviderConnection | null> {
  const row = await db
    .select({
      id: aiProviderConnections.id,
      name: aiProviderConnections.name,
      preset: aiProviderConnections.preset,
      wire: aiProviderConnections.wire,
      baseUrl: aiProviderConnections.baseUrl,
      apiKeySecretRef: aiProviderConnections.apiKeySecretRef,
      headers: aiProviderConnections.headers,
      models: aiProviderConnections.models,
    })
    .from(agents)
    .innerJoin(
      aiProviderConnections,
      and(
        eq(aiProviderConnections.id, agents.providerConnectionId),
        // Join on the company too. The composite foreign key already forbids a
        // cross-company reference; this keeps the read correct even if that
        // constraint is ever relaxed.
        eq(aiProviderConnections.companyId, agents.companyId),
      ),
    )
    .where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.agentId)))
    .then((rows) => rows[0] ?? null);

  if (!row) return null;

  const presetHeaders =
    row.preset !== "custom" && PROVIDER_PRESET_DEFINITIONS[row.preset]?.defaultHeaders
      ? { ...PROVIDER_PRESET_DEFINITIONS[row.preset].defaultHeaders }
      : {};

  let apiKey: string | null = null;
  const ref = asSecretRef(row.apiKeySecretRef);
  if (ref) {
    try {
      apiKey = await secretService(db).resolveSecretValue(
        input.companyId,
        ref.secretId,
        ref.version,
        {
          consumerType: "agent",
          consumerId: input.agentId,
          actorType: "system",
          actorId: "heartbeat",
        } as never,
      );
    } catch (err) {
      // Never log the reference or the value; the connection id is enough to
      // find the row.
      logger.warn(
        { err, connectionId: row.id, agentId: input.agentId, runId: input.runId },
        "provider connection API key could not be resolved",
      );
    }
  }

  return {
    id: row.id,
    name: row.name,
    wire: row.wire,
    baseUrl: row.baseUrl,
    apiKey,
    // Operator headers win over preset defaults; neither may carry auth, which
    // the create/update validator already refuses.
    headers: { ...presetHeaders, ...(row.headers ?? {}) },
    models: row.models ?? [],
  };
}

/**
 * Layers the resolved connection onto an agent's runtime config.
 *
 * Returns the config unchanged when the agent has no provider connection, so
 * every existing agent's config is byte-identical to before.
 */
export function applyProviderConnectionToConfig(
  config: Record<string, unknown>,
  connection: RuntimeProviderConnection | null,
): Record<string, unknown> {
  if (!connection) return config;
  return { ...config, [PROVIDER_CONNECTION_CONFIG_KEY]: connection };
}
