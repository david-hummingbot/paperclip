import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

/**
 * Three mechanisms can point a CLI harness at a model endpoint:
 *
 * 1. A managed AI connection, which owns the run env outright.
 * 2. A provider connection, injected by `applyHarnessProviderConnection`.
 * 3. The agent's own `PAPERCLIP_*_PROVIDERS` / `*_BASE_URL` env hatches.
 *
 * These tests pin the precedence between them. They assert against the real key
 * lists rather than string literals, because the failure mode when the lists
 * drift is silent: tokens go to an endpoint nobody chose.
 */

const ROUTING_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  "XAI_BASE_URL",
  "PAPERCLIP_OPENCODE_PROVIDERS",
  "PAPERCLIP_CODEX_PROVIDERS",
] as const;

describe("a managed AI connection owns the run env", () => {
  it("blanks every routing variable the harnesses read", async () => {
    const { AI_AUTH_ENV_KEYS } = await import("../services/ai-connection-runtime.js");

    // Both provider blobs must be here. `PAPERCLIP_CODEX_PROVIDERS` was missing
    // while its OpenCode twin was present, so a managed connection could be
    // repointed by an agent's own config env.
    for (const key of ROUTING_ENV_KEYS) {
      expect(AI_AUTH_ENV_KEYS).toContain(key);
    }
  });

  it("keeps routing variables out of stripAiAuthBindings' deletions", async () => {
    const { stripAiAuthBindings } = await import("../services/ai-connection-runtime.js");

    // Routing keys are preserved here and blanked later by the managed runtime,
    // rather than deleted, so a caller that strips credentials from an agent's
    // env does not also silently drop its routing.
    const stripped = stripAiAuthBindings(
      Object.fromEntries(ROUTING_ENV_KEYS.map((key) => [key, "value"])),
    );
    for (const key of ROUTING_ENV_KEYS) {
      expect(stripped[key]).toBe("value");
    }
  });

  it("deletes the credential variables it is for", async () => {
    const { stripAiAuthBindings } = await import("../services/ai-connection-runtime.js");
    const stripped = stripAiAuthBindings({
      ANTHROPIC_API_KEY: "sk-a",
      OPENAI_API_KEY: "sk-o",
      KEEP_ME: "yes",
    });
    expect(stripped.ANTHROPIC_API_KEY).toBeUndefined();
    expect(stripped.OPENAI_API_KEY).toBeUndefined();
    expect(stripped.KEEP_ME).toBe("yes");
  });
});

describe("a hired child keeps its own routing", () => {
  it("does not inherit a manager's connection when it carries provider routing", async () => {
    const { defaultAiConnectionForHire } = await import(
      "../services/agent-ai-connection-default.js"
    );
    const managerBinding = { provider: "openai", method: "api_key", mode: "responsible_user" };

    const inherited = defaultAiConnectionForHire(
      "codex_local",
      { model: "gpt-5.1-codex" },
      managerBinding,
    );
    // Baseline: with no routing of its own, the child inherits.
    expect(inherited?.provider).toBe("openai");

    const withOwnRouting = defaultAiConnectionForHire(
      "codex_local",
      {
        model: "gpt-5.1-codex",
        env: { PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({ providers: {} }) },
      },
      managerBinding,
    );
    // A child that names its own endpoint is expressing an auth override, the
    // same way `PAPERCLIP_OPENCODE_PROVIDERS` already did for openrouter.
    // Inheriting here would bind a connection and then route around it.
    expect(withOwnRouting).toBeUndefined();
  });
});

describe("a provider connection wins over the agent's own hatches", () => {
  it("overwrites an agent-configured provider blob rather than merging under it", async () => {
    const { applyHarnessProviderConnection } = await import(
      "../services/provider-connection-runtime.js"
    );

    const result = applyHarnessProviderConnection(
      {
        model: "qwen3-coder-30b",
        env: {
          PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({ stale: {} }),
          UNRELATED: "keep",
        },
      },
      {
        adapterType: "opencode_local",
        connection: {
          id: "conn-1",
          name: "LM Studio",
          wire: "openai_chat",
          baseUrl: "http://localhost:1234/v1",
          apiKey: null,
          headers: {},
          models: [],
        },
      },
    );
    const env = result.config.env as Record<string, string>;

    // The selected connection is the authority on where the model lives.
    expect(env.PAPERCLIP_OPENCODE_PROVIDERS).not.toContain("stale");
    expect(env.PAPERCLIP_OPENCODE_PROVIDERS).toContain("localhost:1234");
    // Everything that is not routing is the agent's own.
    expect(env.UNRELATED).toBe("keep");
  });
});
