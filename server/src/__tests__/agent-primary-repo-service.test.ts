import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
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

/**
 * The partial unique index is the authority on "one agent per repo", so these
 * exercise it against a real database rather than a service method. Agent
 * creation itself lives in the lifecycle module and is not the subject here.
 */
describeEmbeddedPostgres("agent primary repo", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let prefixCounter = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-primary-repo-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    // `companies.issue_prefix` is unique instance-wide, so each company needs
    // its own.
    prefixCounter += 1;
    const [company] = await db
      .insert(companies)
      .values({ name: `co-${randomUUID()}`, issuePrefix: `P${prefixCounter}` })
      .returning();
    return company!.id;
  }

  const addAgent = (companyId: string, name: string, primaryRepoFullName?: string | null) =>
    db
      .insert(agents)
      .values({ companyId, name, adapterType: "process", primaryRepoFullName })
      .returning()
      .then((rows) => rows[0]!);

  async function service() {
    const { agentService } = await import("../services/agents.js");
    return agentService(db);
  }

  it("records the repo an agent owns", async () => {
    const companyId = await seedCompany();
    const agent = await addAgent(companyId, "hummingbot", "hummingbot/hummingbot");
    expect(agent.primaryRepoFullName).toBe("hummingbot/hummingbot");
  });

  it("refuses a second agent claiming the same repo", async () => {
    const companyId = await seedCompany();
    await addAgent(companyId, "owner", "hummingbot/condor");

    // "Which agent owns this repo" has to have one answer: room member seeding
    // reads it, and two claimants would silently seed both.
    await expect(addAgent(companyId, "claimant", "hummingbot/condor")).rejects.toThrow();
  });

  it("frees the repo when its owner releases it", async () => {
    const companyId = await seedCompany();
    const owner = await addAgent(companyId, "owner", "hummingbot/condor");
    const successor = await addAgent(companyId, "successor", null);

    const { eq } = await import("drizzle-orm");
    await db.update(agents).set({ primaryRepoFullName: null }).where(eq(agents.id, owner.id));
    const [updated] = await db
      .update(agents)
      .set({ primaryRepoFullName: "hummingbot/condor" })
      .where(eq(agents.id, successor.id))
      .returning();

    // Handing a repo over is two ordinary writes, not a special operation.
    expect(updated!.primaryRepoFullName).toBe("hummingbot/condor");
  });

  it("lets agents with no repo coexist", async () => {
    const companyId = await seedCompany();

    // The index is partial for exactly this reason: most agents own no repo,
    // and a plain unique index would let only one of them exist.
    await addAgent(companyId, "a", null);
    await addAgent(companyId, "b", null);
    await addAgent(companyId, "c", null);

    expect(await db.select().from(agents)).toHaveLength(3);
  });

  it("scopes ownership to the company", async () => {
    const first = await seedCompany();
    const second = await seedCompany();

    await addAgent(first, "ours", "hummingbot/hummingbot");
    // Another company's agent may own the same public repo; they are separate
    // tenants reviewing it for their own reasons.
    const theirs = await addAgent(second, "theirs", "hummingbot/hummingbot");

    expect(theirs.primaryRepoFullName).toBe("hummingbot/hummingbot");
  });

  it("resolves the agents owning a set of repos", async () => {
    const svc = await service();
    const companyId = await seedCompany();
    const api = await addAgent(companyId, "hummingbot-api", "hummingbot/hummingbot-api");
    const condor = await addAgent(companyId, "condor", "hummingbot/condor");
    await addAgent(companyId, "hummingbot", "hummingbot/hummingbot");

    const owners = await svc.findByPrimaryRepos(companyId, [
      "hummingbot/hummingbot-api",
      "hummingbot/condor",
    ]);

    // The repo the effort does not span contributes nobody.
    expect(owners.map((row) => row.id).sort()).toEqual([api.id, condor.id].sort());
  });

  it("returns nobody for an empty repo list", async () => {
    const svc = await service();
    const companyId = await seedCompany();
    await addAgent(companyId, "owner", "hummingbot/condor");

    // A room opened from no repos seeds no members rather than every agent.
    expect(await svc.findByPrimaryRepos(companyId, [])).toEqual([]);
  });

  it("maps the index violation onto a 409 that names the repo", async () => {
    const companyId = await seedCompany();
    await addAgent(companyId, "owner", "hummingbot/condor");
    const { withPrimaryRepoConflict } = await import("../services/agents.js");

    // The routes wrap their writes with this, so an operator gets a conflict
    // naming the repo rather than a raw database error.
    await expect(
      withPrimaryRepoConflict("hummingbot/condor", () =>
        addAgent(companyId, "claimant", "hummingbot/condor"),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("lets an unrelated failure through untouched", async () => {
    const { withPrimaryRepoConflict } = await import("../services/agents.js");
    const boom = new Error("something else");

    // Only the primary-repo constraint is translated; anything else must keep
    // its own meaning.
    await expect(
      withPrimaryRepoConflict("hummingbot/condor", () => Promise.reject(boom)),
    ).rejects.toBe(boom);
  });
});
