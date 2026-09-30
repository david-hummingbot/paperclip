import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareOpenCodeRuntimeConfig } from "@paperclipai/adapter-opencode-local/server";
import { prepareCodexRuntimeConfig } from "@paperclipai/adapter-codex-local/server";
import {
  applyHarnessProviderConnection,
  INJECTED_PROVIDER_ID,
  PROVIDER_API_KEY_ENV,
} from "../services/provider-connection-runtime.js";

/**
 * The unit tests assert the shape this server *emits*. These assert the shape
 * each harness's own parser *accepts* — the two can drift, and a mismatch
 * would only show up as a failed run against a real endpoint.
 */

const CONNECTION = {
  id: "conn-1",
  name: "LM Studio",
  wire: "openai_chat",
  baseUrl: "http://host.docker.internal:1234/v1",
  apiKey: "sk-test-canary",
  headers: {},
  models: [],
};

const cleanupPaths = new Set<string>();

afterEach(async () => {
  for (const target of cleanupPaths) {
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
  }
  cleanupPaths.clear();
});

describe("OpenCode accepts the injected provider", () => {
  it("writes a runtime config that resolves the agent's model", async () => {
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-oc-roundtrip-"));
    cleanupPaths.add(configHome);
    await fs.mkdir(path.join(configHome, "opencode"), { recursive: true });
    await fs.writeFile(
      path.join(configHome, "opencode", "opencode.json"),
      JSON.stringify({ permission: { read: "allow" } }),
      "utf8",
    );

    const applied = applyHarnessProviderConnection(
      { model: "qwen3-coder-30b" },
      { adapterType: "opencode_local", connection: CONNECTION },
    );
    const injectedEnv = applied.config.env as Record<string, string>;

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, ...injectedEnv },
      config: applied.config,
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    const runtimeConfig = JSON.parse(
      await fs.readFile(
        path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
        "utf8",
      ),
    ) as Record<string, any>;

    // The provider landed, pointed at our endpoint.
    expect(runtimeConfig.provider[INJECTED_PROVIDER_ID].options.baseURL).toBe(CONNECTION.baseUrl);
    // The agent's model resolves: OpenCode only accepts `provider/model` when
    // the model exists in that provider's map.
    expect(runtimeConfig.provider[INJECTED_PROVIDER_ID].models).toHaveProperty("qwen3-coder-30b");
    expect(applied.config.model).toBe(`${INJECTED_PROVIDER_ID}/qwen3-coder-30b`);
    // The auxiliary small model is pinned to a model this endpoint serves.
    expect(runtimeConfig.small_model).toBe(`${INJECTED_PROVIDER_ID}/qwen3-coder-30b`);

    // Paperclip's own generated blob names the key, never carries it.
    expect(injectedEnv.PAPERCLIP_OPENCODE_PROVIDERS).not.toContain("sk-test-canary");
    expect(injectedEnv[PROVIDER_API_KEY_ENV]).toBe("sk-test-canary");

    // OpenCode then resolves the placeholder itself and bakes the value into
    // its managed config, deliberately: the run process may be sandboxed and is
    // not guaranteed to carry the variable to OpenCode's spawned server. So the
    // key IS on disk, and what protects it is where that file lives.
    const configPath = path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json");
    expect(await fs.readFile(configPath, "utf8")).toContain("sk-test-canary");
    // Not the agent's own config home, and not readable by other users.
    expect(prepared.env.XDG_CONFIG_HOME).not.toBe(configHome);
    expect((await fs.stat(prepared.env.XDG_CONFIG_HOME)).mode & 0o077).toBe(0);

    // And the run is what keeps it alive.
    await prepared.cleanup();
    await expect(fs.access(prepared.env.XDG_CONFIG_HOME)).rejects.toThrow();
  });
});

describe("Codex accepts the injected provider", () => {
  it("writes a config.toml that selects the injected provider", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-roundtrip-"));
    cleanupPaths.add(codexHome);
    await fs.writeFile(path.join(codexHome, "config.toml"), 'model = "gpt-5.1-codex"\n', "utf8");

    const applied = applyHarnessProviderConnection(
      { model: "qwen3-coder-30b" },
      { adapterType: "codex_local", connection: CONNECTION },
    );
    const injectedEnv = applied.config.env as Record<string, string>;

    const prepared = await prepareCodexRuntimeConfig({ env: injectedEnv, codexHome });
    const content = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");

    expect(content).toContain(`model_provider = "${INJECTED_PROVIDER_ID}"`);
    expect(content).toContain(`[model_providers.${INJECTED_PROVIDER_ID}]`);
    expect(content).toContain(`base_url = "${CONNECTION.baseUrl}"`);
    expect(content).toContain(`env_key = "${PROVIDER_API_KEY_ENV}"`);
    expect(content).toContain('wire_api = "chat"');
    // The operator's own config survives the merge.
    expect(content).toContain('model = "gpt-5.1-codex"');
    // The key is named, never written into the file.
    expect(content).not.toContain("sk-test-canary");

    await prepared.cleanup();
  });

  it("is a no-op for an agent with no provider connection", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-noop-"));
    cleanupPaths.add(codexHome);
    const original = 'model = "gpt-5.1-codex"\n';
    await fs.writeFile(path.join(codexHome, "config.toml"), original, "utf8");

    const applied = applyHarnessProviderConnection(
      { model: "gpt-5.1-codex" },
      { adapterType: "codex_local", connection: null },
    );
    const prepared = await prepareCodexRuntimeConfig({
      env: (applied.config.env as Record<string, string>) ?? {},
      codexHome,
    });

    // Every existing agent's config.toml must be byte-identical.
    expect(await fs.readFile(path.join(codexHome, "config.toml"), "utf8")).toBe(original);
    await prepared.cleanup();
  });
});
