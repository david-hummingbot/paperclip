import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  coordinationRoomMembers,
  coordinationRooms,
  createDb,
  issues,
} from "@paperclipai/db";
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

const execFileAsync = promisify(execFile);
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

describeEmbeddedPostgres("coordination room workspace", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let prefixCounter = 0;
  const tempPaths = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-room-workspace-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(coordinationRoomMembers);
    await db.delete(coordinationRooms);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    for (const target of tempPaths) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    }
    tempPaths.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** A real repository: the service shells out to git, so a fake would prove nothing. */
  async function createTempRepo() {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-room-repo-"));
    tempPaths.add(repoRoot);
    await runGit(repoRoot, ["init"]);
    await runGit(repoRoot, ["config", "user.email", "paperclip@example.com"]);
    await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
    await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
    await runGit(repoRoot, ["add", "README.md"]);
    await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
    await runGit(repoRoot, ["checkout", "-B", "main"]);
    return repoRoot;
  }

  async function seed(options?: { placements?: Record<string, string> }) {
    prefixCounter += 1;
    const [company] = await db
      .insert(companies)
      .values({ name: `co-${randomUUID()}`, issuePrefix: `R${prefixCounter}` })
      .returning();
    const companyId = company!.id;
    const inserted = await db
      .insert(agents)
      .values([
        {
          companyId,
          name: "hummingbot-api",
          computePlacement: options?.placements?.["hummingbot-api"] ?? "shared",
        },
        {
          companyId,
          name: "condor",
          computePlacement: options?.placements?.condor ?? "shared",
        },
      ])
      .returning();
    const byName = new Map(inserted.map((agent) => [agent.name, agent.id]));

    const [transcript] = await db
      .insert(issues)
      .values({
        companyId,
        title: "api and condor",
        status: "todo",
        priority: "medium",
        // Real transcripts come from the issue service and always carry an
        // identifier; the branch template names it.
        identifier: `R${prefixCounter}-1`,
      })
      .returning();

    const [room] = await db
      .insert(coordinationRooms)
      .values({
        companyId,
        name: "api and condor",
        transcriptIssueId: transcript!.id,
        repoFullNames: [],
      })
      .returning();

    await db.insert(coordinationRoomMembers).values(
      [...byName.values()].map((agentId) => ({ companyId, roomId: room!.id, agentId })),
    );

    const { coordinationRoomWorkspaceService } = await import(
      "../services/coordination-room-workspace.js"
    );
    return {
      svc: coordinationRoomWorkspaceService(db),
      companyId,
      roomId: room!.id,
      transcriptId: transcript!.id,
      identifier: transcript!.identifier,
      byName,
    };
  }

  async function setWorkspaceRoot(roomId: string, repoRoot: string) {
    await db
      .update(coordinationRooms)
      .set({ workspaceRootPath: repoRoot })
      .where(eq(coordinationRooms.id, roomId));
  }

  it("gives each member their own tree and branch", async () => {
    const { svc, companyId, roomId, identifier, byName } = await seed();
    const repoRoot = await createTempRepo();
    await setWorkspaceRoot(roomId, repoRoot);

    const result = await svc.ensureRoomWorkspace(companyId, roomId);

    expect(result.skipped).toEqual([]);
    expect(result.members).toHaveLength(2);

    // The condor agent's tree is not the hummingbot-api agent's tree. Both
    // exist at once, which is the point: only runs serialize, not trees.
    const paths = result.members.map((member) => member.worktreePath);
    expect(new Set(paths).size).toBe(2);
    for (const target of paths) {
      expect(await fs.stat(target).then((entry) => entry.isDirectory())).toBe(true);
    }

    // The branch names the room's transcript and the member, so two rooms do
    // not collide and neither touches the agent's primary-repo review branch.
    for (const member of result.members) {
      expect(member.branchName).toBe(`room/${identifier}/${member.agentName}`);
    }
    expect(result.members.map((member) => member.agentId).sort()).toEqual(
      [...byName.values()].sort(),
    );
  });

  it("records each member's tree so a room wake can find it", async () => {
    const { svc, companyId, roomId, byName } = await seed();
    const repoRoot = await createTempRepo();
    await setWorkspaceRoot(roomId, repoRoot);

    await svc.ensureRoomWorkspace(companyId, roomId);
    const found = await svc.findMemberWorktree({
      companyId,
      roomId,
      agentId: byName.get("condor")!,
    });

    expect(found?.worktreePath).toBeTruthy();
    expect(found?.branchName).toContain("condor");
    const row = await db
      .select()
      .from(coordinationRoomMembers)
      .where(eq(coordinationRoomMembers.agentId, byName.get("condor")!))
      .then((rows) => rows[0]);
    expect(row?.worktreePath).toBe(found?.worktreePath);
  });

  it("is idempotent, so every room wake can call it", async () => {
    const { svc, companyId, roomId } = await seed();
    const repoRoot = await createTempRepo();
    await setWorkspaceRoot(roomId, repoRoot);

    const first = await svc.ensureRoomWorkspace(companyId, roomId);
    const second = await svc.ensureRoomWorkspace(companyId, roomId);

    expect(second.members.map((m) => m.worktreePath).sort()).toEqual(
      first.members.map((m) => m.worktreePath).sort(),
    );
    // The second pass adopts the existing trees rather than cutting new ones.
    expect(second.members.every((member) => member.created)).toBe(false);
  });

  it("refuses to claim a host tree for an agent on its own computer", async () => {
    const { svc, companyId, roomId, byName } = await seed({
      placements: { condor: "docker" },
    });
    const repoRoot = await createTempRepo();
    await setWorkspaceRoot(roomId, repoRoot);

    const result = await svc.ensureRoomWorkspace(companyId, roomId);

    // A tree cut here is on the Paperclip host, and the remote transports
    // discard the host path outright — the agent would run in its container's
    // fixed workspace while we claimed it had a room tree.
    expect(result.members).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.agentId).toBe(byName.get("condor"));
    expect(result.skipped[0]!.reason).toContain("docker");

    // And no path is recorded for them, so the heartbeat finds nothing.
    expect(
      await svc.findMemberWorktree({ companyId, roomId, agentId: byName.get("condor")! }),
    ).toBeNull();
    // The other member is unaffected.
    expect(
      await svc.findMemberWorktree({
        companyId,
        roomId,
        agentId: byName.get("hummingbot-api")!,
      }),
    ).not.toBeNull();
  });

  it("reports a missing tree as absent rather than returning a dead path", async () => {
    const { svc, companyId, roomId, byName } = await seed();
    const repoRoot = await createTempRepo();
    await setWorkspaceRoot(roomId, repoRoot);
    await svc.ensureRoomWorkspace(companyId, roomId);

    const agentId = byName.get("condor")!;
    const before = await svc.findMemberWorktree({ companyId, roomId, agentId });
    await fs.rm(before!.worktreePath, { recursive: true, force: true });

    // The row records what was created, not proof it still exists. An operator
    // who removed the tree should get the agent's ordinary cwd, not a run that
    // starts in a missing directory.
    expect(await svc.findMemberWorktree({ companyId, roomId, agentId })).toBeNull();
  });

  it("refuses a workspace path that is not a git checkout", async () => {
    const { svc, companyId, roomId } = await seed();
    const plainDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-room-plain-"));
    tempPaths.add(plainDir);
    await setWorkspaceRoot(roomId, plainDir);

    // Saying so here beats one raw git failure per member.
    await expect(svc.ensureRoomWorkspace(companyId, roomId)).rejects.toThrow(
      /not a git checkout/,
    );
  });

  it("refuses a room with no workspace and no project", async () => {
    const { svc, companyId, roomId } = await seed();

    await expect(svc.ensureRoomWorkspace(companyId, roomId)).rejects.toThrow(
      /workspaceRootPath/,
    );
  });

  it("refuses a room with no transcript, since the branch is named after it", async () => {
    const { svc, companyId, roomId } = await seed();
    const repoRoot = await createTempRepo();
    await setWorkspaceRoot(roomId, repoRoot);
    await db
      .update(coordinationRooms)
      .set({ transcriptIssueId: null })
      .where(eq(coordinationRooms.id, roomId));

    await expect(svc.ensureRoomWorkspace(companyId, roomId)).rejects.toThrow(/transcript/);
  });

  it("keeps a member's tree when they leave the room", async () => {
    const { svc, companyId, roomId, byName } = await seed();
    const repoRoot = await createTempRepo();
    await setWorkspaceRoot(roomId, repoRoot);
    await svc.ensureRoomWorkspace(companyId, roomId);
    const agentId = byName.get("condor")!;
    const tree = await svc.findMemberWorktree({ companyId, roomId, agentId });

    const { coordinationRoomService } = await import("../services/coordination-rooms.js");
    await coordinationRoomService(db).removeMember(companyId, roomId, agentId);

    // Removing a member must not destroy uncommitted work. Unmerged branches
    // stay until someone deletes them deliberately.
    expect(await fs.stat(tree!.worktreePath).then((entry) => entry.isDirectory())).toBe(true);
  });
});

describe("pinRoomWorktreeWorkspaceStrategy", () => {
  it("leaves a run with no room tree untouched", async () => {
    const { pinRoomWorktreeWorkspaceStrategy } = await import("../services/heartbeat.js");
    const config = { workspaceStrategy: { type: "git_worktree" } };
    expect(pinRoomWorktreeWorkspaceStrategy(config, false)).toBe(config);
  });

  it("stops a room run cutting a worktree inside the member's worktree", async () => {
    const { pinRoomWorktreeWorkspaceStrategy } = await import("../services/heartbeat.js");
    const { resolveEffectiveWorkspaceStrategyType } = await import(
      "../services/execution-workspace-policy.js"
    );

    // The agent is configured to isolate every run in its own worktree. On a
    // room wake its cwd is already the member's tree, so realizing that
    // strategy again would nest a tree inside a tree and move the run off the
    // branch the room gave this member.
    const pinned = pinRoomWorktreeWorkspaceStrategy(
      { workspaceStrategy: { type: "git_worktree", branchTemplate: "{{issue.identifier}}" } },
      true,
    );

    expect(resolveEffectiveWorkspaceStrategyType("isolated_workspace", pinned)).toBe(
      "project_primary",
    );
  });

  it("keeps the rest of the config", async () => {
    const { pinRoomWorktreeWorkspaceStrategy } = await import("../services/heartbeat.js");
    const pinned = pinRoomWorktreeWorkspaceStrategy(
      { model: "keep-me", workspaceStrategy: { type: "git_worktree" } },
      true,
    );
    expect(pinned.model).toBe("keep-me");
  });
});
