import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, aiProviderConnections, companies, createDb } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  applyProviderPreset,
  createProviderConnectionSchema,
  isLoopbackProviderBaseUrl,
  providerBaseUrlSchema,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

describe("provider connection base URL validation", () => {
  // The announcement feed rejects private destinations because it fetches a
  // URL the instance discovered. A provider base URL is operator-typed
  // configuration, and applying the same rule would block every local model.
  it.each([
    "http://localhost:1234/v1",
    "http://127.0.0.1:11434/v1",
    "http://host.docker.internal:1234/v1",
    "http://192.168.1.50:8000/v1",
    "https://api.venice.ai/api/v1",
  ])("accepts %s", (url) => {
    expect(providerBaseUrlSchema.safeParse(url).success).toBe(true);
  });

  it.each([
    ["a non-HTTP scheme", "ftp://example.test/v1"],
    ["a relative URL", "/v1"],
    ["embedded credentials", "https://user:pass@example.test/v1"],
    ["a query string", "https://example.test/v1?key=secret"],
    ["a fragment", "https://example.test/v1#frag"],
  ])("rejects %s", (_label, url) => {
    expect(providerBaseUrlSchema.safeParse(url).success).toBe(false);
  });

  it("recognises the hosts that mean the agent's own machine", () => {
    expect(isLoopbackProviderBaseUrl("http://localhost:1234/v1")).toBe(true);
    expect(isLoopbackProviderBaseUrl("http://127.0.0.1:1234/v1")).toBe(true);
    // host.docker.internal is the *host* seen from a container, not loopback.
    expect(isLoopbackProviderBaseUrl("http://host.docker.internal:1234/v1")).toBe(false);
    expect(isLoopbackProviderBaseUrl("https://api.openai.com/v1")).toBe(false);
  });

  it("refuses an Authorization header so a key cannot be pasted into config", () => {
    const parsed = createProviderConnectionSchema.safeParse({
      name: "Gateway",
      wire: "openai_chat",
      baseUrl: "https://gw.example.test/v1",
      headers: { Authorization: "Bearer sk-live-canary" },
    });
    expect(parsed.success).toBe(false);
  });

  it("fills a preset's endpoint while letting the caller override it", () => {
    const local = applyProviderPreset("local_openai");
    expect(local.baseUrl).toBe("http://localhost:1234/v1");
    expect(local.wire).toBe("openai_chat");

    // Ollama and vLLM are this preset with the port edited.
    const ollama = applyProviderPreset("local_openai", { baseUrl: "http://localhost:11434/v1" });
    expect(ollama.baseUrl).toBe("http://localhost:11434/v1");
    expect(ollama.preset).toBe("local_openai");
  });
});

describeEmbeddedPostgres("provider connection service", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let otherCompanyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-provider-connections-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(aiProviderConnections);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const [company] = await db
      .insert(companies)
      .values({ name: `co-${randomUUID()}`, issuePrefix: "PC" })
      .returning();
    const [other] = await db
      .insert(companies)
      .values({ name: `co-${randomUUID()}`, issuePrefix: "OT" })
      .returning();
    companyId = company!.id;
    otherCompanyId = other!.id;
    const { providerConnectionService } = await import("../services/provider-connections.js");
    return providerConnectionService(db);
  }

  it("stores a keyless local endpoint and never returns the key reference", async () => {
    const svc = await seed();
    const created = await svc.create(companyId, {
      name: "LM Studio",
      preset: "local_openai",
      wire: "openai_chat",
      baseUrl: "http://localhost:1234/v1/",
      apiKeySecretRef: null,
      headers: {},
      models: ["qwen3-coder-30b"],
    });

    // A trailing slash would make new URL("chat/completions", base) drop the
    // last path segment, so it is normalised on write.
    expect(created.baseUrl).toBe("http://localhost:1234/v1");
    expect(created.hasApiKey).toBe(false);
    expect(Object.keys(created)).not.toContain("apiKeySecretRef");
  });

  it("refuses a keyless remote endpoint but allows a keyless loopback one", async () => {
    const svc = await seed();
    await expect(
      svc.create(companyId, {
        name: "Venice",
        preset: "venice",
        wire: "openai_chat",
        baseUrl: "https://api.venice.ai/api/v1",
        apiKeySecretRef: null,
        headers: {},
        models: [],
      }),
    ).rejects.toThrow(/requires an API key/);

    await expect(
      svc.create(companyId, {
        name: "Ollama",
        preset: "local_openai",
        wire: "openai_chat",
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKeySecretRef: null,
        headers: {},
        models: [],
      }),
    ).resolves.toMatchObject({ hasApiKey: false });
  });

  it("scopes names per company rather than instance-wide", async () => {
    const svc = await seed();
    const input = {
      name: "Shared name",
      preset: "custom" as const,
      wire: "openai_chat" as const,
      baseUrl: "http://localhost:1234/v1",
      apiKeySecretRef: null,
      headers: {},
      models: [],
    };
    await svc.create(companyId, input);
    // The same name in another company must be allowed; a second one in the
    // same company must not.
    await expect(svc.create(otherCompanyId, input)).resolves.toMatchObject({
      companyId: otherCompanyId,
    });
    await expect(svc.create(companyId, input)).rejects.toThrow(/already exists/);
  });

  it("hides another company's connection behind a 404", async () => {
    const svc = await seed();
    const mine = await svc.create(companyId, {
      name: "Mine",
      preset: "custom",
      wire: "openai_chat",
      baseUrl: "http://localhost:1234/v1",
      apiKeySecretRef: null,
      headers: {},
      models: [],
    });
    await expect(svc.getById(otherCompanyId, mine.id)).rejects.toThrow(/not found/i);
  });

  it("detaches bound agents on delete instead of cascading them away", async () => {
    const svc = await seed();
    const connection = await svc.create(companyId, {
      name: "Local",
      preset: "local_openai",
      wire: "openai_chat",
      baseUrl: "http://localhost:1234/v1",
      apiKeySecretRef: null,
      headers: {},
      models: [],
    });
    const [agent] = await db
      .insert(agents)
      .values({ companyId, name: "condor", providerConnectionId: connection.id })
      .returning();

    const result = await svc.remove(companyId, connection.id);

    expect(result.detachedAgentIds).toEqual([agent!.id]);
    const [reloaded] = await db.select().from(agents).where(eq(agents.id, agent!.id));
    expect(reloaded).toBeDefined();
    expect(reloaded!.providerConnectionId).toBeNull();
  });
});
