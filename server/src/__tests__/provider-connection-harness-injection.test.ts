import { describe, expect, it } from "vitest";
import {
  applyHarnessProviderConnection,
  buildCodexProviderEnv,
  buildHarnessInjection,
  buildOpenCodeProviderEnv,
  INJECTED_PROVIDER_ID,
  openCodeModelRef,
  PROVIDER_API_KEY_ENV,
} from "../services/provider-connection-runtime.js";

const LOCAL = {
  id: "conn-1",
  name: "LM Studio",
  wire: "openai_chat",
  baseUrl: "http://host.docker.internal:1234/v1",
  apiKey: null as string | null,
  headers: {} as Record<string, string>,
  models: [] as string[],
};

const GATEWAY = { ...LOCAL, name: "Gateway", apiKey: "sk-live", headers: { "X-Title": "Paperclip" } };

describe("openCodeModelRef", () => {
  it("qualifies a bare model with the injected provider", () => {
    expect(openCodeModelRef("qwen3-coder-30b")).toBe(`${INJECTED_PROVIDER_ID}/qwen3-coder-30b`);
  });

  it("keeps a vendor-qualified id intact as the model part", () => {
    // OpenCode splits on the FIRST slash, so `qwen/qwen3-coder` survives whole.
    expect(openCodeModelRef("qwen/qwen3-coder")).toBe(`${INJECTED_PROVIDER_ID}/qwen/qwen3-coder`);
  });

  it("does not double-prefix an already-qualified ref", () => {
    const once = openCodeModelRef("m");
    expect(openCodeModelRef(once)).toBe(once);
  });
});

describe("OpenCode provider env", () => {
  it("emits the provider shape OpenCode parses, with an explicit models map", () => {
    const env = buildOpenCodeProviderEnv({ connection: GATEWAY, model: "qwen3-coder-30b" });
    const providers = JSON.parse(env.PAPERCLIP_OPENCODE_PROVIDERS!);

    expect(providers[INJECTED_PROVIDER_ID]).toMatchObject({
      npm: "@ai-sdk/openai-compatible",
      name: "Gateway",
      options: {
        baseURL: "http://host.docker.internal:1234/v1",
        headers: { "X-Title": "Paperclip" },
      },
    });
    // OPENCODE_ALLOW_ALL_MODELS does not bypass OpenCode's getModel(), so an
    // unlisted id is rejected even when the endpoint serves it.
    expect(providers[INJECTED_PROVIDER_ID].models).toEqual({ "qwen3-coder-30b": {} });
  });

  it("references the key by env var rather than inlining it in the JSON", () => {
    const env = buildOpenCodeProviderEnv({ connection: GATEWAY, model: "m" });
    expect(env.PAPERCLIP_OPENCODE_PROVIDERS).not.toContain("sk-live");
    expect(JSON.parse(env.PAPERCLIP_OPENCODE_PROVIDERS!)[INJECTED_PROVIDER_ID].options.apiKey).toBe(
      `{env:${PROVIDER_API_KEY_ENV}}`,
    );
    expect(env[PROVIDER_API_KEY_ENV]).toBe("sk-live");
  });

  it("omits the key entirely for a keyless local endpoint", () => {
    const env = buildOpenCodeProviderEnv({ connection: LOCAL, model: "m" });
    expect(env[PROVIDER_API_KEY_ENV]).toBeUndefined();
    expect(JSON.parse(env.PAPERCLIP_OPENCODE_PROVIDERS!)[INJECTED_PROVIDER_ID].options)
      .not.toHaveProperty("apiKey");
  });

  it("pins the auxiliary small model so title generation cannot abort the run", () => {
    // OpenCode's default small model is a built-in provider id a repointed
    // endpoint will not serve, and that failure kills the whole run.
    const env = buildOpenCodeProviderEnv({ connection: LOCAL, model: "qwen3-coder-30b" });
    expect(env.PAPERCLIP_OPENCODE_SMALL_MODEL).toBe(`${INJECTED_PROVIDER_ID}/qwen3-coder-30b`);
  });

  it("registers the bare model id even when given an already-qualified ref", () => {
    const env = buildOpenCodeProviderEnv({
      connection: LOCAL,
      model: `${INJECTED_PROVIDER_ID}/qwen3-coder-30b`,
    });
    expect(JSON.parse(env.PAPERCLIP_OPENCODE_PROVIDERS!)[INJECTED_PROVIDER_ID].models).toEqual({
      "qwen3-coder-30b": {},
    });
  });
});

describe("Codex provider env", () => {
  it("emits the config.toml shape Codex parses", () => {
    const env = buildCodexProviderEnv({ connection: GATEWAY });
    const parsed = JSON.parse(env.PAPERCLIP_CODEX_PROVIDERS!);

    expect(parsed.model_provider).toBe(INJECTED_PROVIDER_ID);
    expect(parsed.providers[INJECTED_PROVIDER_ID]).toMatchObject({
      base_url: "http://host.docker.internal:1234/v1",
      env_key: PROVIDER_API_KEY_ENV,
      wire_api: "chat",
      http_headers: { "X-Title": "Paperclip" },
    });
    expect(env.PAPERCLIP_CODEX_PROVIDERS).not.toContain("sk-live");
    expect(env[PROVIDER_API_KEY_ENV]).toBe("sk-live");
  });

  it("maps the responses wire onto Codex's own name for it", () => {
    const env = buildCodexProviderEnv({
      connection: { ...LOCAL, wire: "openai_responses" },
    });
    expect(JSON.parse(env.PAPERCLIP_CODEX_PROVIDERS!).providers[INJECTED_PROVIDER_ID].wire_api).toBe(
      "responses",
    );
  });
});

describe("buildHarnessInjection", () => {
  it("rewrites the model for OpenCode and leaves it alone for Codex", () => {
    expect(
      buildHarnessInjection({ adapterType: "opencode_local", connection: LOCAL, model: "m" }).model,
    ).toBe(`${INJECTED_PROVIDER_ID}/m`);
    // Codex's --model picks the model *within* the selected provider.
    expect(
      buildHarnessInjection({ adapterType: "codex_local", connection: LOCAL, model: "m" }).model,
    ).toBeUndefined();
  });

  it("repoints the Claude CLI through the supported Anthropic env", () => {
    const injection = buildHarnessInjection({
      adapterType: "claude_local",
      connection: { ...LOCAL, wire: "anthropic", apiKey: "sk-a" },
      model: "m",
    });
    expect(injection.env).toEqual({
      ANTHROPIC_BASE_URL: LOCAL.baseUrl,
      ANTHROPIC_AUTH_TOKEN: "sk-a",
    });
  });

  it("skips with a reason when the adapter and the connection wire disagree", () => {
    // The Claude CLI speaks the Anthropic wire; an OpenAI endpoint would be
    // mis-sent rather than simply unsupported.
    const injection = buildHarnessInjection({
      adapterType: "claude_local",
      connection: LOCAL,
      model: "m",
    });
    expect(injection.env).toEqual({});
    expect(injection.skipped).toContain("anthropic");
  });

  it("says nothing for an adapter that reads the connection itself", () => {
    // openai_compatible runs *on* the connection via the runtime-config key.
    // A "not applied" warning on every one of its runs would be false.
    const injection = buildHarnessInjection({
      adapterType: "openai_compatible",
      connection: LOCAL,
      model: "m",
    });
    expect(injection.env).toEqual({});
    expect(injection.skipped).toBeUndefined();
  });

  it("skips an adapter that has no injection path at all", () => {
    const injection = buildHarnessInjection({
      adapterType: "process",
      connection: LOCAL,
      model: "m",
    });
    expect(injection.skipped).toContain("process");
  });

  it("skips OpenCode with no model rather than registering an empty id", () => {
    expect(
      buildHarnessInjection({ adapterType: "opencode_local", connection: LOCAL, model: "  " })
        .skipped,
    ).toContain("model");
  });
});

describe("applyHarnessProviderConnection", () => {
  it("leaves the config untouched when the agent has no connection", () => {
    const config = { model: "m", env: { A: "1" } };
    expect(applyHarnessProviderConnection(config, {
      adapterType: "opencode_local",
      connection: null,
    }).config).toBe(config);
  });

  it("merges the injected env over the agent's own and rewrites the model", () => {
    const result = applyHarnessProviderConnection(
      { model: "qwen3-coder-30b", env: { EXISTING: "keep" } },
      { adapterType: "opencode_local", connection: LOCAL },
    );
    const env = result.config.env as Record<string, string>;
    expect(env.EXISTING).toBe("keep");
    expect(env.PAPERCLIP_OPENCODE_PROVIDERS).toBeTruthy();
    expect(result.config.model).toBe(`${INJECTED_PROVIDER_ID}/qwen3-coder-30b`);
  });

  it("reports a mismatch without changing the config", () => {
    const config = { model: "m" };
    const result = applyHarnessProviderConnection(config, {
      adapterType: "claude_local",
      connection: LOCAL,
    });
    // The agent still runs on its normal credentials; the reason is surfaced.
    expect(result.config).toBe(config);
    expect(result.skipped).toBeTruthy();
  });
});
