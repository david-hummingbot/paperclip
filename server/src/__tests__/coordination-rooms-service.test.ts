import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

describeEmbeddedPostgres("coordination room service", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-coordination-rooms-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(coordinationRoomMembers);
    await db.delete(coordinationRooms);
    await db.delete(issues);
    await db.delete(agents);
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
    const companyId = company!.id;
    const inserted = await db
      .insert(agents)
      .values([
        { companyId, name: "hummingbot", primaryRepoFullName: "hummingbot/hummingbot" },
        { companyId, name: "hummingbot-api", primaryRepoFullName: "hummingbot/hummingbot-api" },
        { companyId, name: "condor", primaryRepoFullName: "hummingbot/condor" },
      ])
      .returning();
    const byName = new Map(inserted.map((agent) => [agent.name, agent.id]));
    const { coordinationRoomService } = await import("../services/coordination-rooms.js");
    return { svc: coordinationRoomService(db), companyId, byName };
  }

  async function seedTranscript(companyId: string, title: string) {
    const [issue] = await db
      .insert(issues)
      .values({ companyId, title, status: "todo", priority: "medium" })
      .returning();
    return issue!.id;
  }

  it("seeds members from the repos the effort spans", async () => {
    const { svc, companyId, byName } = await seed();

    // Opening a room from two repos pre-fills the agents that own them. The
    // hummingbot agent owns a third repo and must not be pulled in.
    const room = await svc.create(companyId, {
      name: "api + condor integration",
      description: null,
      projectId: null,
      repoFullNames: ["hummingbot/hummingbot-api", "hummingbot/condor"],
      agentIds: [],
      seedMembersFromRepos: true,
    });

    expect(room.members.map((member) => member.agentName).sort()).toEqual([
      "condor",
      "hummingbot-api",
    ]);
    expect(room.members.map((member) => member.agentId)).not.toContain(byName.get("hummingbot"));
  });

  it("lets one agent belong to several rooms at once", async () => {
    const { svc, companyId, byName } = await seed();
    await svc.create(companyId, {
      name: "api room",
      description: null,
      projectId: null,
      repoFullNames: ["hummingbot/hummingbot-api", "hummingbot/condor"],
      agentIds: [],
      seedMembersFromRepos: true,
    });
    await svc.create(companyId, {
      name: "hummingbot room",
      description: null,
      projectId: null,
      repoFullNames: ["hummingbot/condor", "hummingbot/hummingbot"],
      agentIds: [],
      seedMembersFromRepos: true,
    });

    // Membership is a join table, not a single conversationAgentId: the condor
    // agent is in both rooms while hummingbot-api is only in the first.
    const condorRooms = await svc.listForAgent(companyId, byName.get("condor")!);
    expect(condorRooms.map((room) => room.name).sort()).toEqual(["api room", "hummingbot room"]);
    const apiRooms = await svc.listForAgent(companyId, byName.get("hummingbot-api")!);
    expect(apiRooms.map((room) => room.name)).toEqual(["api room"]);
  });

  it("refuses an assigned issue as a transcript so single-assignee holds", async () => {
    const { svc, companyId, byName } = await seed();
    const room = await svc.create(companyId, {
      name: "assignment guard",
      description: null,
      projectId: null,
      repoFullNames: [],
      agentIds: [],
      seedMembersFromRepos: false,
    });
    const [assigned] = await db
      .insert(issues)
      .values({
        companyId,
        title: "already owned",
        status: "todo",
        priority: "medium",
        assigneeAgentId: byName.get("condor")!,
      })
      .returning();

    await expect(svc.setTranscriptIssue(companyId, room.id, assigned!.id)).rejects.toThrow(
      /must be unassigned/,
    );
  });

  it("wakes every member when a message carries no mention", async () => {
    const { svc, companyId } = await seed();
    const room = await svc.create(companyId, {
      name: "broadcast",
      description: null,
      projectId: null,
      repoFullNames: ["hummingbot/hummingbot-api", "hummingbot/condor"],
      agentIds: [],
      seedMembersFromRepos: true,
    });
    const transcriptIssueId = await seedTranscript(companyId, "broadcast transcript");
    await svc.setTranscriptIssue(companyId, room.id, transcriptIssueId);

    const plan = await svc.planWake(companyId, room.id, []);

    expect(plan.broadcast).toBe(true);
    expect(plan.agentIds).toHaveLength(2);
    // Every member is queued against the one transcript issue, whose execution
    // lock makes them run one at a time.
    expect(plan.transcriptIssueId).toBe(transcriptIssueId);
  });

  it("wakes only the mentioned members, and ignores a mentioned non-member", async () => {
    const { svc, companyId, byName } = await seed();
    const room = await svc.create(companyId, {
      name: "mentions",
      description: null,
      projectId: null,
      repoFullNames: ["hummingbot/hummingbot-api", "hummingbot/condor"],
      agentIds: [],
      seedMembersFromRepos: true,
    });
    await svc.setTranscriptIssue(
      companyId,
      room.id,
      await seedTranscript(companyId, "mention transcript"),
    );

    const plan = await svc.planWake(companyId, room.id, [
      byName.get("condor")!,
      // Not a member of this room. A mention must not silently add them.
      byName.get("hummingbot")!,
    ]);

    expect(plan.broadcast).toBe(false);
    expect(plan.agentIds).toEqual([byName.get("condor")!]);
  });

  it("stops waking once the room is closed", async () => {
    const { svc, companyId } = await seed();
    const room = await svc.create(companyId, {
      name: "closing",
      description: null,
      projectId: null,
      repoFullNames: ["hummingbot/condor"],
      agentIds: [],
      seedMembersFromRepos: true,
    });
    await svc.setTranscriptIssue(
      companyId,
      room.id,
      await seedTranscript(companyId, "closing transcript"),
    );

    const closed = await svc.update(companyId, room.id, { status: "closed" });
    expect(closed.closedAt).not.toBeNull();
    await expect(svc.planWake(companyId, room.id, [])).rejects.toThrow(/closed/);
  });

  it("refuses a wake before the room has a transcript", async () => {
    const { svc, companyId } = await seed();
    const room = await svc.create(companyId, {
      name: "no transcript",
      description: null,
      projectId: null,
      repoFullNames: [],
      agentIds: [],
      seedMembersFromRepos: false,
    });
    await expect(svc.planWake(companyId, room.id, [])).rejects.toThrow(/transcript/);
  });

  it("records one worktree and branch per member", async () => {
    const { svc, companyId, byName } = await seed();
    const room = await svc.create(companyId, {
      name: "worktrees",
      description: null,
      projectId: null,
      repoFullNames: [],
      agentIds: [byName.get("condor")!, byName.get("hummingbot-api")!],
      seedMembersFromRepos: false,
    });

    await svc.addMember(companyId, room.id, {
      agentId: byName.get("condor")!,
      worktreePath: "/w/room/condor",
      branchName: "room/condor",
    });
    const updated = await svc.addMember(companyId, room.id, {
      agentId: byName.get("hummingbot-api")!,
      worktreePath: "/w/room/api",
      branchName: "room/api",
    });

    // The condor agent's tree is not the hummingbot-api agent's tree.
    const trees = new Map(updated.members.map((m) => [m.agentName, m.worktreePath]));
    expect(trees.get("condor")).toBe("/w/room/condor");
    expect(trees.get("hummingbot-api")).toBe("/w/room/api");
    expect(updated.members).toHaveLength(2);
  });

  it("hides another company's room behind a 404", async () => {
    const { svc, companyId } = await seed();
    const room = await svc.create(companyId, {
      name: "scoped",
      description: null,
      projectId: null,
      repoFullNames: [],
      agentIds: [],
      seedMembersFromRepos: false,
    });
    const [other] = await db
      .insert(companies)
      .values({ name: `co-${randomUUID()}`, issuePrefix: "OT" })
      .returning();

    await expect(svc.getById(other!.id, room.id)).rejects.toThrow(/not found/i);
  });
});
