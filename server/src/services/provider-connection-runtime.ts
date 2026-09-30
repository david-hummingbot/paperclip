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

// ---------------------------------------------------------------------------
// CLI harness injection
//
// A local model is a cost choice, not a reduced role: it is expected to edit
// files and run commands like any other agent. The `openai_compatible` adapter
// cannot do that — a raw completions call has no file or shell tools — so
// parity comes from pointing an existing CLI harness at the connection.
//
// `opencode_local` and `codex_local` already accept an arbitrary
// OpenAI-compatible endpoint through two env JSON blobs. Filling those from the
// agent's selected connection turns "which model does this agent use" into a
// connection choice, with the agent's tools, skills, workspace and permissions
// completely unchanged.
// ---------------------------------------------------------------------------

/**
 * The provider id Paperclip registers inside each harness's own config.
 *
 * A fixed id rather than one derived from the connection name: the name is
 * operator-editable and may contain characters neither harness accepts in a
 * provider key, and nothing else in the generated config refers to it.
 */
export const INJECTED_PROVIDER_ID = "paperclip";

/**
 * The env var that carries the resolved key.
 *
 * Both harnesses are handed the key *by name* rather than by value — OpenCode
 * through an `{env:NAME}` placeholder, Codex through `env_key` — so the value
 * appears in exactly one variable and never in the JSON blobs Paperclip
 * generates, which are what shows up in run diagnostics.
 *
 * Where the value ends up after that differs, and the difference is the
 * harness's, not ours:
 *
 * - **Codex** keeps the name. `config.toml` stores `env_key` and Codex reads
 *   the variable when it makes the call, so the key is never on disk.
 * - **OpenCode** resolves the placeholder server-side, in
 *   `prepareOpenCodeRuntimeConfig`, and writes the value into the managed
 *   `opencode.json` — on purpose: the run process may be sandboxed and is not
 *   guaranteed to carry the variable through to OpenCode's spawned server.
 *   That file lives in a per-run `mkdtemp` directory (mode 0700) under
 *   `XDG_CONFIG_HOME` which `cleanup()` removes when the run ends, which is the
 *   same treatment OpenCode's other managed credentials already get.
 */
export const PROVIDER_API_KEY_ENV = "PAPERCLIP_PROVIDER_API_KEY";

function codexWireApi(wire: string): "responses" | "chat" {
  return wire === "openai_responses" ? "responses" : "chat";
}

/**
 * OpenCode resolves `--model provider/model` only when the model exists in a
 * provider's `models` map, so the configured model is rewritten to name the
 * injected provider. `parseConfiguredModelRef` splits on the first slash, so a
 * vendor-qualified id such as `qwen/qwen3-coder` survives intact as the model
 * part.
 */
export function openCodeModelRef(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return trimmed;
  return trimmed.startsWith(`${INJECTED_PROVIDER_ID}/`)
    ? trimmed
    : `${INJECTED_PROVIDER_ID}/${trimmed}`;
}

export function buildOpenCodeProviderEnv(input: {
  connection: RuntimeProviderConnection;
  model: string;
}): Record<string, string> {
  const modelId = input.model.trim().replace(new RegExp(`^${INJECTED_PROVIDER_ID}/`), "");
  const providers = {
    [INJECTED_PROVIDER_ID]: {
      npm: "@ai-sdk/openai-compatible",
      name: input.connection.name,
      options: {
        baseURL: input.connection.baseUrl,
        ...(input.connection.apiKey ? { apiKey: `{env:${PROVIDER_API_KEY_ENV}}` } : {}),
        ...(Object.keys(input.connection.headers).length > 0
          ? { headers: input.connection.headers }
          : {}),
      },
      // An explicit models map is required: OPENCODE_ALLOW_ALL_MODELS does not
      // bypass OpenCode's internal getModel(), so an unlisted id is rejected
      // with "Model not found" even when the endpoint serves it.
      models: { [modelId]: {} },
    },
  };
  return {
    PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(providers),
    // OpenCode uses an auxiliary "small" model for session titles and similar
    // helper calls. Its default is a built-in provider model that a repointed
    // endpoint will not serve, and that failure aborts the run — so pin it to
    // the same model the agent is using.
    PAPERCLIP_OPENCODE_SMALL_MODEL: openCodeModelRef(modelId),
    ...(input.connection.apiKey ? { [PROVIDER_API_KEY_ENV]: input.connection.apiKey } : {}),
  };
}

export function buildCodexProviderEnv(input: {
  connection: RuntimeProviderConnection;
}): Record<string, string> {
  const providers = {
    providers: {
      [INJECTED_PROVIDER_ID]: {
        name: input.connection.name,
        base_url: input.connection.baseUrl,
        // Named, not inlined: Codex reads the bearer from this variable.
        env_key: PROVIDER_API_KEY_ENV,
        wire_api: codexWireApi(input.connection.wire),
        ...(Object.keys(input.connection.headers).length > 0
          ? { http_headers: input.connection.headers }
          : {}),
      },
    },
    // Codex's `--model` flag picks the model *within* the selected provider,
    // so the provider is chosen here and the agent's `model` stays untouched.
    model_provider: INJECTED_PROVIDER_ID,
  };
  return {
    PAPERCLIP_CODEX_PROVIDERS: JSON.stringify(providers),
    ...(input.connection.apiKey ? { [PROVIDER_API_KEY_ENV]: input.connection.apiKey } : {}),
  };
}

/**
 * The Claude CLI speaks the Anthropic wire, so it can only use a connection
 * that serves it. `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` are already
 * the supported way to repoint it, and `stripAiAuthBindings` deliberately
 * preserves the base URL, so this is the existing path rather than a new one.
 */
export function buildClaudeProviderEnv(input: {
  connection: RuntimeProviderConnection;
}): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: input.connection.baseUrl,
    ...(input.connection.apiKey ? { ANTHROPIC_AUTH_TOKEN: input.connection.apiKey } : {}),
  };
}

/** Adapter types this injection understands, and the wire each one needs. */
const HARNESS_WIRES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  opencode_local: ["openai_chat", "openai_responses"],
  codex_local: ["openai_chat", "openai_responses"],
  claude_local: ["anthropic"],
});

/**
 * Adapters that read the connection off the runtime config themselves.
 *
 * They need no env injection, and saying so is not a diagnostic — without this
 * set every `openai_compatible` run would log "connection not applied" while
 * running on exactly that connection.
 */
const NATIVE_CONNECTION_ADAPTERS: ReadonlySet<string> = new Set(["openai_compatible"]);

export interface HarnessInjection {
  env: Record<string, string>;
  /** Present only when the harness needs the configured model rewritten. */
  model?: string;
  /** Why nothing was injected, for the run log. */
  skipped?: string;
}

/**
 * Builds the env (and, for OpenCode, the rewritten model ref) that points a CLI
 * harness at a provider connection.
 *
 * Returns a `skipped` reason rather than throwing: an agent whose adapter and
 * connection wire do not match should run on its normal credentials with a
 * diagnostic, not fail to start.
 */
export function buildHarnessInjection(input: {
  adapterType: string;
  connection: RuntimeProviderConnection;
  model: string;
}): HarnessInjection {
  if (NATIVE_CONNECTION_ADAPTERS.has(input.adapterType)) return { env: {} };
  const wires = HARNESS_WIRES[input.adapterType];
  if (!wires) {
    return { env: {}, skipped: `${input.adapterType} does not accept an injected provider endpoint` };
  }
  if (!wires.includes(input.connection.wire)) {
    return {
      env: {},
      skipped: `${input.adapterType} needs a ${wires.join(" or ")} connection, but "${input.connection.name}" is ${input.connection.wire}`,
    };
  }
  if (input.adapterType === "opencode_local") {
    if (!input.model.trim()) {
      return { env: {}, skipped: "opencode_local needs a model to register with the provider" };
    }
    return {
      env: buildOpenCodeProviderEnv({ connection: input.connection, model: input.model }),
      model: openCodeModelRef(input.model),
    };
  }
  if (input.adapterType === "codex_local") {
    return { env: buildCodexProviderEnv({ connection: input.connection }) };
  }
  return { env: buildClaudeProviderEnv({ connection: input.connection }) };
}

/**
 * Layers a provider connection onto a CLI harness's runtime config.
 *
 * Paperclip-assigned env wins over the agent's own config env for these keys,
 * because the selected connection is the authority on where the model lives.
 */
export function applyHarnessProviderConnection(
  config: Record<string, unknown>,
  input: { adapterType: string; connection: RuntimeProviderConnection | null },
): { config: Record<string, unknown>; skipped?: string } {
  if (!input.connection) return { config };
  const model = typeof config.model === "string" ? config.model : "";
  const injection = buildHarnessInjection({
    adapterType: input.adapterType,
    connection: input.connection,
    model,
  });
  if (Object.keys(injection.env).length === 0) {
    return { config, ...(injection.skipped ? { skipped: injection.skipped } : {}) };
  }
  const existingEnv =
    config.env && typeof config.env === "object" && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  return {
    config: {
      ...config,
      ...(injection.model ? { model: injection.model } : {}),
      env: { ...existingEnv, ...injection.env },
    },
  };
}
