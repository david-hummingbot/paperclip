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

  async function service() {
    const { agentService } = await import("../services/agents.js");
    return agentService(db);
  }

  it("records the repo an agent owns", async () => {
    const svc = await service();
    const companyId = await seedCompany();

    const agent = await svc.create(companyId, {
      name: "hummingbot",
      adapterType: "process",
      primaryRepoFullName: "hummingbot/hummingbot",
    });

    expect(agent.primaryRepoFullName).toBe("hummingbot/hummingbot");
  });

  it("refuses a second agent claiming the same repo", async () => {
    const svc = await service();
    const companyId = await seedCompany();
    await svc.create(companyId, {
      name: "owner",
      adapterType: "process",
      primaryRepoFullName: "hummingbot/condor",
    });

    // "Which agent owns this repo" has to have one answer: room member seeding
    // reads it, and two claimants would silently seed both.
    await expect(
      svc.create(companyId, {
        name: "claimant",
        adapterType: "process",
        primaryRepoFullName: "hummingbot/condor",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses an update that takes a repo another agent owns", async () => {
    const svc = await service();
    const companyId = await seedCompany();
    await svc.create(companyId, {
      name: "owner",
      adapterType: "process",
      primaryRepoFullName: "hummingbot/condor",
    });
    const other = await svc.create(companyId, { name: "other", adapterType: "process" });

    await expect(
      svc.update(other.id, { primaryRepoFullName: "hummingbot/condor" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("frees the repo when its owner releases it", async () => {
    const svc = await service();
    const companyId = await seedCompany();
    const owner = await svc.create(companyId, {
      name: "owner",
      adapterType: "process",
      primaryRepoFullName: "hummingbot/condor",
    });
    const successor = await svc.create(companyId, { name: "successor", adapterType: "process" });

    await svc.update(owner.id, { primaryRepoFullName: null });
    const updated = await svc.update(successor.id, {
      primaryRepoFullName: "hummingbot/condor",
    });

    // Handing a repo over is two ordinary updates, not a special operation.
    expect(updated?.primaryRepoFullName).toBe("hummingbot/condor");
  });

  it("lets agents with no repo coexist", async () => {
    const svc = await service();
    const companyId = await seedCompany();

    // The index is partial for exactly this reason: most agents own no repo,
    // and a plain unique index would let only one of them exist.
    await svc.create(companyId, { name: "a", adapterType: "process" });
    await svc.create(companyId, { name: "b", adapterType: "process" });
    await svc.create(companyId, { name: "c", adapterType: "process" });

    const rows = await db.select().from(agents);
    expect(rows).toHaveLength(3);
  });

  it("scopes ownership to the company", async () => {
    const svc = await service();
    const first = await seedCompany();
    const second = await seedCompany();

    await svc.create(first, {
      name: "ours",
      adapterType: "process",
      primaryRepoFullName: "hummingbot/hummingbot",
    });
    // Another company's agent may own the same public repo; they are separate
    // tenants reviewing it for their own reasons.
    const theirs = await svc.create(second, {
      name: "theirs",
      adapterType: "process",
      primaryRepoFullName: "hummingbot/hummingbot",
    });

    expect(theirs.primaryRepoFullName).toBe("hummingbot/hummingbot");
  });

  it("resolves the agents owning a set of repos", async () => {
    const svc = await service();
    const companyId = await seedCompany();
    const api = await svc.create(companyId, {
      name: "hummingbot-api",
      adapterType: "process",
      primaryRepoFullName: "hummingbot/hummingbot-api",
    });
    const condor = await svc.create(companyId, {
      name: "condor",
      adapterType: "process",
      primaryRepoFullName: "hummingbot/condor",
    });
    await svc.create(companyId, {
      name: "hummingbot",
      adapterType: "process",
      primaryRepoFullName: "hummingbot/hummingbot",
    });

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
    await svc.create(companyId, {
      name: "owner",
      adapterType: "process",
      primaryRepoFullName: "hummingbot/condor",
    });

    // A room opened from no repos seeds no members rather than every agent.
    expect(await svc.findByPrimaryRepos(companyId, [])).toEqual([]);
  });
});
