import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, aiProviderConnections, companies, createDb } from "@paperclipai/db";
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

describe("applyProviderConnectionToConfig", () => {
  it("leaves an agent with no connection byte-identical", async () => {
    const { applyProviderConnectionToConfig } = await import(
      "../services/provider-connection-runtime.js"
    );
    const config = { model: "x", env: { A: "1" } };
    // Every existing agent must see exactly the config it saw before.
    expect(applyProviderConnectionToConfig(config, null)).toBe(config);
  });

  it("adds the endpoint under the key the adapter reads", async () => {
    const { applyProviderConnectionToConfig, PROVIDER_CONNECTION_CONFIG_KEY } = await import(
      "../services/provider-connection-runtime.js"
    );
    const applied = applyProviderConnectionToConfig(
      { model: "x" },
      {
        id: "c1",
        name: "Local",
        wire: "openai_chat",
        baseUrl: "http://localhost:1234/v1",
        apiKey: null,
        headers: {},
        models: [],
      },
    );
    expect(applied[PROVIDER_CONNECTION_CONFIG_KEY]).toMatchObject({
      baseUrl: "http://localhost:1234/v1",
      wire: "openai_chat",
    });
    expect(applied.model).toBe("x");
  });
});

describeEmbeddedPostgres("resolveAgentProviderConnection", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-provider-connection-runtime-");
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

  // `companies.issue_prefix` is unique instance-wide, so each seeded company
  // needs its own.
  let prefixCounter = 0;
  async function seed(input: { bind: boolean; preset?: string }) {
    prefixCounter += 1;
    const [company] = await db
      .insert(companies)
      .values({ name: `co-${randomUUID()}`, issuePrefix: `P${prefixCounter}` })
      .returning();
    const [connection] = await db
      .insert(aiProviderConnections)
      .values({
        companyId: company!.id,
        name: "OpenRouter",
        preset: (input.preset ?? "openrouter") as never,
        wire: "openai_chat",
        baseUrl: "https://openrouter.ai/api/v1",
        headers: { "X-Title": "Paperclip" },
        models: ["a/b"],
      })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        name: "agent",
        ...(input.bind ? { providerConnectionId: connection!.id } : {}),
      })
      .returning();
    return { companyId: company!.id, agentId: agent!.id, connectionId: connection!.id };
  }

  it("returns null for an agent with no connection", async () => {
    const { resolveAgentProviderConnection } = await import(
      "../services/provider-connection-runtime.js"
    );
    const { companyId, agentId } = await seed({ bind: false });
    await expect(
      resolveAgentProviderConnection(db, { companyId, agentId, runId: "r1" }),
    ).resolves.toBeNull();
  });

  it("merges preset headers under the operator's own", async () => {
    const { resolveAgentProviderConnection } = await import(
      "../services/provider-connection-runtime.js"
    );
    const { companyId, agentId } = await seed({ bind: true });

    const resolved = await resolveAgentProviderConnection(db, { companyId, agentId, runId: "r1" });

    expect(resolved).not.toBeNull();
    // The preset contributes HTTP-Referer; the operator's X-Title survives.
    expect(resolved!.headers["X-Title"]).toBe("Paperclip");
    expect(resolved!.headers["HTTP-Referer"]).toBeTruthy();
    expect(resolved!.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(resolved!.apiKey).toBeNull();
  });

  it("does not resolve another company's agent", async () => {
    const { resolveAgentProviderConnection } = await import(
      "../services/provider-connection-runtime.js"
    );
    const { agentId } = await seed({ bind: true });
    const other = await seed({ bind: true });

    // Asking under the wrong company must not return the connection.
    await expect(
      resolveAgentProviderConnection(db, {
        companyId: other.companyId,
        agentId,
        runId: "r1",
      }),
    ).resolves.toBeNull();
  });
});
