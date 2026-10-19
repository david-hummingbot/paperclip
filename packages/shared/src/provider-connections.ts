import { z } from "zod";

/**
 * Provider connections split the credential from the harness.
 *
 * Upstream Paperclip hard-wires four providers (`anthropic`, `openai`,
 * `openrouter`, `xai`) into a TypeScript union *and* a database CHECK
 * constraint, each pinned to one harness and one env var. Anything else — a
 * private gateway, Venice, an OpenAI-compatible model server on the operator's
 * own machine — had to go through one of two undocumented per-harness env
 * hatches (`PAPERCLIP_OPENCODE_PROVIDERS`, `PAPERCLIP_CODEX_PROVIDERS`).
 *
 * A provider connection is a company-scoped row instead: a name, a wire
 * format, a base URL, and an optional key in the existing secret store.
 * Adding a vendor adds a row, not a branch in compatibility code.
 *
 * Scope note: a connection is *the* provider an agent uses, not a pool it
 * picks from per task. Fallback chains and cost-based routing are a separate
 * feature with their own failure semantics.
 */

/** How Paperclip talks to the endpoint, independent of which vendor serves it. */
export const PROVIDER_WIRE_FORMATS = [
  "openai_chat",
  "openai_responses",
  "anthropic",
  "acp",
] as const;
export type ProviderWireFormat = (typeof PROVIDER_WIRE_FORMATS)[number];

/** Preset identifiers. `custom` is the same record with a user-supplied base URL. */
export const PROVIDER_PRESETS = [
  "openai",
  "anthropic",
  "openrouter",
  "venice",
  "xai",
  "local_openai",
  "custom",
] as const;
export type ProviderPreset = (typeof PROVIDER_PRESETS)[number];

export interface ProviderPresetDefinition {
  /** Display name suggested when the operator picks this preset. */
  label: string;
  wire: ProviderWireFormat;
  baseUrl: string;
  /** Whether the endpoint requires an API key. Local model servers do not. */
  requiresApiKey: boolean;
  /**
   * Whether `GET {baseUrl}/models` is expected to work. When false the caller
   * falls back to a static list or a free-text model id.
   */
  supportsModelDiscovery: boolean;
  /** Headers this vendor expects beyond auth, merged under operator headers. */
  defaultHeaders?: Readonly<Record<string, string>>;
  notes?: string;
}

export const PROVIDER_PRESET_DEFINITIONS: Readonly<
  Record<Exclude<ProviderPreset, "custom">, ProviderPresetDefinition>
> = Object.freeze({
  openai: {
    label: "OpenAI",
    wire: "openai_responses",
    baseUrl: "https://api.openai.com/v1",
    requiresApiKey: true,
    supportsModelDiscovery: true,
  },
  anthropic: {
    label: "Anthropic",
    wire: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    requiresApiKey: true,
    supportsModelDiscovery: true,
  },
  openrouter: {
    label: "OpenRouter",
    wire: "openai_chat",
    baseUrl: "https://openrouter.ai/api/v1",
    requiresApiKey: true,
    supportsModelDiscovery: true,
    defaultHeaders: Object.freeze({ "HTTP-Referer": "https://paperclip.local" }),
  },
  venice: {
    label: "Venice",
    wire: "openai_chat",
    baseUrl: "https://api.venice.ai/api/v1",
    requiresApiKey: true,
    supportsModelDiscovery: true,
  },
  xai: {
    label: "xAI",
    wire: "openai_chat",
    baseUrl: "https://api.x.ai/v1",
    requiresApiKey: true,
    supportsModelDiscovery: true,
  },
  local_openai: {
    label: "Local model server",
    wire: "openai_chat",
    // LM Studio's default. Ollama (11434) and vLLM (8000) are the same shape
    // with a different port, so they are this preset with the URL edited.
    baseUrl: "http://localhost:1234/v1",
    requiresApiKey: false,
    supportsModelDiscovery: true,
    notes:
      "Covers LM Studio, Ollama and vLLM. The host is resolved on the agent's computer, not the Paperclip server: a Docker agent needs host.docker.internal and an SSH agent needs an address reachable from that host.",
  },
});

/**
 * Header names an operator may not set. Auth is derived from
 * `apiKeySecretRef` so a key can never be pasted into free-text config, where
 * it would be stored unencrypted and echoed back by the read API.
 */
const RESERVED_HEADER_NAMES = new Set(["authorization", "x-api-key", "proxy-authorization"]);

const headerNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "Header names must be RFC 7230 tokens")
  .refine(
    (name) => !RESERVED_HEADER_NAMES.has(name.toLowerCase()),
    "Authorization headers are derived from the connection's API key, not set by hand",
  );

/**
 * Base URL validation is deliberately permissive about *destination* and
 * strict about *shape*.
 *
 * Loopback and private addresses must be allowed: a local model server lives
 * on 127.0.0.1, a Docker agent reaches the host at host.docker.internal, and a
 * private gateway lives on an RFC 1918 address. The SSRF guard that
 * `guardedRemoteHttpFetch` applies to the announcement feed is right for a
 * URL the instance discovered and wrong for one the operator typed — applying
 * it here would block every local model.
 *
 * What is rejected is a URL that cannot be a usable API root: a non-HTTP
 * scheme, embedded credentials (they belong in the secret store), or a query
 * string or fragment (an API root takes neither, and both are places a key
 * gets leaked into logs).
 */
export const providerBaseUrlSchema = z
  .string()
  .trim()
  .min(1, "A provider connection needs a base URL.")
  .max(2048)
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "Base URL must be an absolute URL." });
      return;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      ctx.addIssue({ code: "custom", message: "Base URL must use http or https." });
    }
    if (url.username || url.password) {
      ctx.addIssue({
        code: "custom",
        message: "Put credentials in the connection's API key, not in the base URL.",
      });
    }
    if (url.search || url.hash) {
      ctx.addIssue({
        code: "custom",
        message: "Base URL must not carry a query string or fragment.",
      });
    }
  });

/** True when the URL points at the machine the agent runs on rather than a remote host. */
export function isLoopbackProviderBaseUrl(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost")
  );
}

const secretRefSchema = z
  .object({
    type: z.literal("secret_ref"),
    secretId: z.string().uuid(),
    version: z.union([z.literal("latest"), z.number().int().positive()]).default("latest"),
  })
  .strict();

export const providerConnectionHeadersSchema = z
  .record(headerNameSchema, z.string().trim().max(4096))
  .refine((headers) => Object.keys(headers).length <= 25, "At most 25 extra headers.");

const providerConnectionFields = {
  name: z.string().trim().min(1).max(160),
  preset: z.enum(PROVIDER_PRESETS).default("custom"),
  wire: z.enum(PROVIDER_WIRE_FORMATS),
  baseUrl: providerBaseUrlSchema,
  apiKeySecretRef: secretRefSchema.nullable().default(null),
  headers: providerConnectionHeadersSchema.default({}),
  /**
   * Model ids to offer when discovery is unavailable or the endpoint serves
   * ids its catalog does not list. Free-text because a local server's model
   * ids are whatever the operator loaded.
   */
  models: z.array(z.string().trim().min(1).max(320)).max(200).default([]),
};

export const createProviderConnectionSchema = z.object(providerConnectionFields).strict();
export type CreateProviderConnection = z.infer<typeof createProviderConnectionSchema>;

export const updateProviderConnectionSchema = z
  .object(providerConnectionFields)
  .strict()
  .partial()
  .refine((value) => Object.keys(value).length > 0, "No fields to update.");
export type UpdateProviderConnection = z.infer<typeof updateProviderConnectionSchema>;

export interface ProviderConnection {
  id: string;
  companyId: string;
  name: string;
  preset: ProviderPreset;
  wire: ProviderWireFormat;
  baseUrl: string;
  /** Whether a key is stored. The key itself is never returned by the API. */
  hasApiKey: boolean;
  headers: Record<string, string>;
  models: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Applies a preset's defaults to a partial create payload. The operator can
 * override any field afterwards; `custom` contributes nothing.
 */
export function applyProviderPreset(
  preset: ProviderPreset,
  overrides: Partial<CreateProviderConnection> = {},
): Partial<CreateProviderConnection> {
  if (preset === "custom") return { ...overrides, preset };
  const definition = PROVIDER_PRESET_DEFINITIONS[preset];
  return {
    name: definition.label,
    wire: definition.wire,
    baseUrl: definition.baseUrl,
    ...(definition.defaultHeaders ? { headers: { ...definition.defaultHeaders } } : {}),
    ...overrides,
    preset,
  };
}
