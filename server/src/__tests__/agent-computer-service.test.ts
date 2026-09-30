import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environments } from "@paperclipai/db";
import { eq } from "drizzle-orm";
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

// The service must never shell out during these tests: they cover the control
// plane (which rows change, which errors are raised), not the Docker daemon.
const dockerMocks = vi.hoisted(() => ({
  inspectContainerState: vi.fn(async () => "missing" as const),
  ensureContainerRunning: vi.fn(async () => ({ state: "running" as const, created: true })),
  stopContainer: vi.fn(async () => {}),
  removeContainer: vi.fn(async () => {}),
}));

vi.mock("@paperclipai/adapter-utils/docker", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/docker")>(
    "@paperclipai/adapter-utils/docker",
  );
  return { ...actual, ...dockerMocks };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

describeEmbeddedPostgres("agent computer service", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let prefixCounter = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-computer-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.update(agents).set({ defaultEnvironmentId: null });
    await db.delete(environments);
    await db.delete(agents);
    await db.delete(companies);
    for (const mock of Object.values(dockerMocks)) mock.mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    prefixCounter += 1;
    const [company] = await db
      .insert(companies)
      .values({ name: `co-${randomUUID()}`, issuePrefix: `P${prefixCounter}` })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({ companyId: company!.id, name: "condor" })
      .returning();
    const { agentComputerService } = await import("../services/agent-computer.js");
    return { svc: agentComputerService(db), companyId: company!.id, agentId: agent!.id };
  }

  it("starts every agent on the shared host", async () => {
    const { svc, companyId, agentId } = await seed();
    const computer = await svc.get(companyId, agentId);
    expect(computer.placement).toBe("shared");
    expect(computer.environmentId).toBeNull();
  });

  it("creates a company- and agent-owned environment for a docker placement", async () => {
    const { svc, companyId, agentId } = await seed();

    const computer = await svc.setPlacement(companyId, agentId, {
      placement: "docker",
      image: "paperclip-local:latest",
      memoryLimit: "4g",
    });

    expect(computer.placement).toBe("docker");
    const [row] = await db
      .select()
      .from(environments)
      .where(eq(environments.id, computer.environmentId!));
    // Ownership is what stops another company selecting this machine.
    expect(row!.companyId).toBe(companyId);
    expect(row!.agentId).toBe(agentId);
    expect(row!.driver).toBe("docker");
    expect(row!.config).toMatchObject({ image: "paperclip-local:latest", memoryLimit: "4g" });
    // Names are derived, not operator input, so a rename cannot orphan them.
    expect(row!.config.containerName).toContain(agentId.replace(/[^a-z0-9_.-]/gi, "").toLowerCase());
  });

  it("refuses a docker placement with no image", async () => {
    const { svc, companyId, agentId } = await seed();
    await expect(
      svc.setPlacement(companyId, agentId, { placement: "docker" }),
    ).rejects.toThrow(/needs an image/);
  });

  it("reuses the agent's environment row when the image changes", async () => {
    const { svc, companyId, agentId } = await seed();
    const first = await svc.setPlacement(companyId, agentId, {
      placement: "docker",
      image: "a:1",
    });
    const second = await svc.setPlacement(companyId, agentId, {
      placement: "docker",
      image: "b:2",
    });

    expect(second.environmentId).toBe(first.environmentId);
    const rows = await db.select().from(environments).where(eq(environments.agentId, agentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.config).toMatchObject({ image: "b:2" });
  });

  it("returning to shared drops the environment but leaves the container alone", async () => {
    const { svc, companyId, agentId } = await seed();
    await svc.setPlacement(companyId, agentId, { placement: "docker", image: "a:1" });

    const computer = await svc.setPlacement(companyId, agentId, { placement: "shared" });

    expect(computer.placement).toBe("shared");
    expect(await db.select().from(environments).where(eq(environments.agentId, agentId))).toEqual(
      [],
    );
    // Changing placement must not destroy uncommitted work; reclaiming the
    // container is an explicit, separate action.
    expect(dockerMocks.removeContainer).not.toHaveBeenCalled();
  });

  it("keeps the volume on terminate unless asked to remove it", async () => {
    const { svc, companyId, agentId } = await seed();
    await svc.setPlacement(companyId, agentId, { placement: "docker", image: "a:1" });

    await svc.terminateContainer(companyId, agentId);
    // The key is omitted rather than passed as undefined, so the docker helper
    // falls to its own keep-the-volume default.
    expect(dockerMocks.removeContainer).toHaveBeenCalledWith(expect.anything(), {});

    dockerMocks.removeContainer.mockClear();
    const result = await svc.terminateContainer(companyId, agentId, { removeVolume: true });
    expect(result.volumeRemoved).toBe(true);
    expect(dockerMocks.removeContainer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ removeVolume: true }),
    );
  });

  it("refuses container lifecycle calls for a shared agent", async () => {
    const { svc, companyId, agentId } = await seed();
    await expect(svc.startContainer(companyId, agentId)).rejects.toThrow(/no Docker computer/);
    await expect(svc.pauseContainer(companyId, agentId)).rejects.toThrow(/no Docker computer/);
  });

  it("reports the container state without failing when Docker is unavailable", async () => {
    const { svc, companyId, agentId } = await seed();
    await svc.setPlacement(companyId, agentId, { placement: "docker", image: "a:1" });
    dockerMocks.inspectContainerState.mockRejectedValueOnce(new Error("docker: not found"));

    // Reading an agent's settings must not depend on a working daemon.
    const computer = await svc.get(companyId, agentId);
    expect(computer.placement).toBe("docker");
    expect(computer.containerState).toBe("missing");
  });

  it("hides another company's agent behind a 404", async () => {
    const { svc, agentId } = await seed();
    const other = await seed();
    await expect(svc.get(other.companyId, agentId)).rejects.toThrow(/not found/i);
  });
});
