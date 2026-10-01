import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  coordinationRoomMembers,
  coordinationRooms,
  createDb,
  issueComments,
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
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(deps?: {
    wakeup?: (agentId: string, opts?: Record<string, unknown>) => Promise<unknown>;
  }) {
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
    return { svc: coordinationRoomService(db, deps ?? {}), companyId, byName };
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
      createTranscriptIssue: false,
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
      createTranscriptIssue: false,
    });
    await svc.create(companyId, {
      name: "hummingbot room",
      description: null,
      projectId: null,
      repoFullNames: ["hummingbot/condor", "hummingbot/hummingbot"],
      agentIds: [],
      seedMembersFromRepos: true,
      createTranscriptIssue: false,
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
      createTranscriptIssue: false,
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
      createTranscriptIssue: false,
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
      createTranscriptIssue: false,
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
      createTranscriptIssue: false,
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
      createTranscriptIssue: false,
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
      createTranscriptIssue: false,
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

  it("opens the room with its own unassigned transcript issue", async () => {
    const { svc, companyId } = await seed();
    const room = await svc.create(companyId, {
      name: "api and condor",
      description: "Test a change across both.",
      projectId: null,
      repoFullNames: ["hummingbot/hummingbot-api", "hummingbot/condor"],
      agentIds: [],
      seedMembersFromRepos: true,
      createTranscriptIssue: true,
    });

    expect(room.transcriptIssueId).toBeTruthy();
    const [transcript] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, room.transcriptIssueId!));

    // Unassigned, so the single-assignee task model holds even though two
    // agents work the thread.
    expect(transcript!.assigneeAgentId).toBeNull();
    expect(transcript!.assigneeUserId).toBeNull();
    // A real issue, with a real identifier — the thread UI and the session
    // taskKey both depend on it.
    expect(transcript!.identifier).toMatch(/^PC-\d+$/);
    expect(room.transcriptIssueIdentifier).toBe(transcript!.identifier);
  });

  it("can open a room without a transcript, for an existing thread", async () => {
    const { svc, companyId } = await seed();
    const room = await svc.create(companyId, {
      name: "bring your own thread",
      description: null,
      projectId: null,
      repoFullNames: [],
      agentIds: [],
      seedMembersFromRepos: false,
      createTranscriptIssue: false,
    });

    expect(room.transcriptIssueId).toBeNull();
    // The attach path still works, so an existing issue can become the thread.
    const attached = await svc.setTranscriptIssue(
      companyId,
      room.id,
      await seedTranscript(companyId, "existing thread"),
    );
    expect(attached.transcriptIssueId).toBeTruthy();
  });

  it("posts a message and wakes every member in membership order", async () => {
    const woken: { agentId: string; context: Record<string, unknown> }[] = [];
    const { svc, companyId, byName } = await seed({
      wakeup: async (agentId, opts) => {
        woken.push({
          agentId,
          context: (opts?.contextSnapshot as Record<string, unknown>) ?? {},
        });
        return null;
      },
    });
    const room = await svc.create(companyId, {
      name: "fan out",
      description: null,
      projectId: null,
      repoFullNames: ["hummingbot/hummingbot-api", "hummingbot/condor"],
      agentIds: [],
      seedMembersFromRepos: true,
      createTranscriptIssue: true,
    });

    const result = await svc.postMessage(
      companyId,
      room.id,
      { body: "Please run the integration suite.", mentionAgentIds: [] },
      { actorType: "user", actorId: randomUUID(), agentId: null },
    );

    expect(result.broadcast).toBe(true);
    expect(result.transcriptIssueId).toBe(room.transcriptIssueId);
    // Enqueued one at a time, in membership order, so the serialized queue is
    // deterministic rather than whatever order the wakes happened to resolve.
    expect(result.wokeAgentIds).toEqual(room.members.map((member) => member.agentId));
    expect(woken.map((entry) => entry.agentId)).toEqual(result.wokeAgentIds);

    // Every wake names the transcript issue, which is what gives each member a
    // session scoped to this room and what makes their runs serialize.
    for (const entry of woken) {
      expect(entry.context.issueId).toBe(room.transcriptIssueId);
      expect(entry.context.coordinationRoomId).toBe(room.id);
      expect(entry.context.wakeCommentId).toBe(result.commentId);
    }

    // The message is a real comment on the transcript.
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, room.transcriptIssueId!));
    expect(comments.map((comment) => comment.body)).toContain(
      "Please run the integration suite.",
    );
  });

  it("wakes members with a context the dispatcher accepts on an unassigned issue", async () => {
    // The transcript is unassigned on purpose, and `decideIssueOwnership`
    // cancels a queued run whose agent does not own the issue unless the wake
    // is an interaction wake. Assert against the real policy predicate, not a
    // string literal: if the allowed set changes, room wakes must break here
    // rather than in production as runs that queue and are then cancelled.
    const { allowsIssueInteractionWake } = await import(
      "../modules/run-dispatch/domain/wake-context.js"
    );
    const { ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS } = await import(
      "../services/issue-tree-control.js"
    );

    const contexts: Record<string, unknown>[] = [];
    const { svc, companyId } = await seed({
      wakeup: async (_agentId, opts) => {
        contexts.push((opts?.contextSnapshot as Record<string, unknown>) ?? {});
        return null;
      },
    });
    const room = await svc.create(companyId, {
      name: "dispatch shape",
      description: null,
      projectId: null,
      repoFullNames: ["hummingbot/hummingbot-api", "hummingbot/condor"],
      agentIds: [],
      seedMembersFromRepos: true,
      createTranscriptIssue: true,
    });

    await svc.postMessage(
      companyId,
      room.id,
      { body: "Kick off the cross-repo run.", mentionAgentIds: [] },
      { actorType: "user", actorId: randomUUID(), agentId: null },
    );

    expect(contexts).toHaveLength(2);
    for (const context of contexts) {
      expect(
        allowsIssueInteractionWake(context, ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS),
      ).toBe(true);
    }

    // And the transcript really is unassigned, so this bypass is load-bearing
    // rather than incidental.
    const [transcript] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, room.transcriptIssueId!));
    expect(transcript!.assigneeAgentId).toBeNull();
  });

  it("wakes only the agents the message body mentions", async () => {
    const woken: string[] = [];
    const { svc, companyId, byName } = await seed({
      wakeup: async (agentId) => {
        woken.push(agentId);
        return null;
      },
    });
    const room = await svc.create(companyId, {
      name: "mention fan out",
      description: null,
      projectId: null,
      repoFullNames: ["hummingbot/hummingbot-api", "hummingbot/condor"],
      agentIds: [],
      seedMembersFromRepos: true,
      createTranscriptIssue: true,
    });

    const condor = byName.get("condor")!;
    // The board composer writes mention links into the body; a room message is
    // parsed exactly like any other issue comment, so no separate id list is
    // needed to narrow the fan-out.
    const result = await svc.postMessage(
      companyId,
      room.id,
      { body: `[@condor](agent://${condor}) can you take this?`, mentionAgentIds: [] },
      { actorType: "user", actorId: randomUUID(), agentId: null },
    );

    expect(result.broadcast).toBe(false);
    expect(result.wokeAgentIds).toEqual([condor]);
    expect(woken).toEqual([condor]);
  });

  it("does not wake an agent on its own message", async () => {
    const woken: string[] = [];
    const { svc, companyId, byName } = await seed({
      wakeup: async (agentId) => {
        woken.push(agentId);
        return null;
      },
    });
    const room = await svc.create(companyId, {
      name: "self post",
      description: null,
      projectId: null,
      repoFullNames: ["hummingbot/hummingbot-api", "hummingbot/condor"],
      agentIds: [],
      seedMembersFromRepos: true,
      createTranscriptIssue: true,
    });

    const condor = byName.get("condor")!;
    const result = await svc.postMessage(
      companyId,
      room.id,
      { body: "Suite is green on my side.", mentionAgentIds: [] },
      { actorType: "agent", actorId: condor, agentId: condor },
    );

    // The other member hears about it; the author does not wake itself into a
    // loop.
    expect(result.wokeAgentIds).not.toContain(condor);
    expect(result.wokeAgentIds).toHaveLength(1);
    expect(woken).toEqual(result.wokeAgentIds);
  });

  it("still posts the message when one member's wake is refused", async () => {
    const { svc, companyId, byName } = await seed({
      wakeup: async (agentId) => {
        // A spent budget or a paused agent refuses its wake. The message is
        // already posted and the other members still need it.
        if (agentId === byName.get("condor")) throw new Error("budget exhausted");
        return null;
      },
    });
    const room = await svc.create(companyId, {
      name: "partial wake",
      description: null,
      projectId: null,
      repoFullNames: ["hummingbot/hummingbot-api", "hummingbot/condor"],
      agentIds: [],
      seedMembersFromRepos: true,
      createTranscriptIssue: true,
    });

    const result = await svc.postMessage(
      companyId,
      room.id,
      { body: "Status?", mentionAgentIds: [] },
      { actorType: "user", actorId: randomUUID(), agentId: null },
    );

    expect(result.commentId).toBeTruthy();
    expect(result.wokeAgentIds).not.toContain(byName.get("condor"));
    expect(result.wokeAgentIds).toHaveLength(1);
  });

  it("refuses a message to a closed room", async () => {
    const { svc, companyId } = await seed({ wakeup: async () => null });
    const room = await svc.create(companyId, {
      name: "closing time",
      description: null,
      projectId: null,
      repoFullNames: ["hummingbot/condor"],
      agentIds: [],
      seedMembersFromRepos: true,
      createTranscriptIssue: true,
    });
    await svc.update(companyId, room.id, { status: "closed" });

    await expect(
      svc.postMessage(
        companyId,
        room.id,
        { body: "one more thing", mentionAgentIds: [] },
        { actorType: "user", actorId: randomUUID(), agentId: null },
      ),
    ).rejects.toThrow(/closed/);
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
      createTranscriptIssue: false,
    });
    const [other] = await db
      .insert(companies)
      .values({ name: `co-${randomUUID()}`, issuePrefix: "OT" })
      .returning();

    await expect(svc.getById(other!.id, room.id)).rejects.toThrow(/not found/i);
  });
});
