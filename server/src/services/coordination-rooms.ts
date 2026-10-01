import { and, asc, eq, inArray } from "drizzle-orm";
import {
  agents,
  coordinationRoomMembers,
  coordinationRooms,
  issues,
  type Db,
} from "@paperclipai/db";
import type {
  AddCoordinationRoomMember,
  CoordinationRoom,
  CoordinationRoomMember,
  CoordinationRoomMessageResult,
  CreateCoordinationRoom,
  PostCoordinationRoomMessage,
  UpdateCoordinationRoom,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { issueService } from "./issues.js";
import { logger } from "../middleware/logger.js";

type RoomRow = typeof coordinationRooms.$inferSelect;

/**
 * The transcript issue's description.
 *
 * It says what the thread is, because the issue is also reachable from the
 * normal issue list, where a bare room name would look like an unowned task
 * nobody picked up.
 */
function transcriptDescription(input: CreateCoordinationRoom): string {
  const lines = [`Transcript for the **${input.name}** coordination room.`];
  if (input.description) lines.push("", input.description);
  if (input.repoFullNames.length > 0) {
    lines.push("", `Repositories: ${input.repoFullNames.join(", ")}.`);
  }
  lines.push(
    "",
    "This issue stays unassigned. Room members are woken through the room's",
    "membership list, and their runs serialize on this issue's execution lock.",
  );
  return lines.join("\n");
}

/**
 * The wake entry point, injected rather than imported.
 *
 * `heartbeat.wakeup` is the real implementation. Taking it as a dependency
 * keeps this service out of the heartbeat's import graph and lets a test assert
 * the fan-out — who is queued and in what order — without running an adapter.
 */
export type CoordinationRoomWakeup = (
  agentId: string,
  opts?: {
    source?: "timer" | "assignment" | "on_demand" | "automation";
    triggerDetail?: "manual" | "ping" | "callback" | "system";
    reason?: string | null;
    payload?: Record<string, unknown> | null;
    requestedByActorType?: "user" | "agent" | "system";
    requestedByActorId?: string | null;
    contextSnapshot?: Record<string, unknown>;
  },
) => Promise<unknown>;

/**
 * A room wake is a mention wake. This is not a cosmetic choice.
 *
 * The transcript issue is deliberately unassigned, and every gate that lets a
 * run start on an issue its agent does not own keys off this exact reason:
 *
 * - `decideIssueOwnership` (`modules/run-dispatch/domain/policy.ts`) cancels a
 *   queued run as `issue_assignee_changed` unless `isInteractionWake` holds,
 *   and `allowsIssueInteractionWake` grants that only for a wake reason in
 *   `ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS` *with* a resolvable comment
 *   id. A bespoke `coordination_room_message` reason would be enqueued and then
 *   silently cancelled at dispatch.
 * - The deferred-wake drain (`modules/wake-queue/application/use-cases.ts`)
 *   cancels a non-assignee's queued comment wake as belonging to the current
 *   assignee — but excludes `issue_comment_mentioned` precisely so a mention
 *   survives. Room members queued behind another member's run need that.
 * - `shouldAutoCheckoutIssueForWake` refuses to auto-check-out on this reason,
 *   which is what stops N members fighting over one issue's assignment.
 *
 * A room does not need new wake policy; it needs a second way to decide who was
 * named. That is the membership list, and everything after it is the existing
 * mention path. Renaming this to something room-specific means re-deriving all
 * three bypasses above.
 *
 * `source` must stay in `ISSUE_TREE_CONTROL_INTERACTION_WAKE_SOURCES` for this
 * reason, or pause-hold admission stops treating the wake as an interaction.
 */
const ROOM_WAKE_REASON = "issue_comment_mentioned";
const ROOM_WAKE_SOURCE = "comment.mention";

/** Who is posting into the room. */
export interface CoordinationRoomActor {
  actorType: "user" | "agent" | "system";
  actorId: string | null;
  agentId?: string | null;
  runId?: string | null;
}

export interface RoomWakePlan {
  roomId: string;
  transcriptIssueId: string;
  /** Members to enqueue, in a stable order so the serialized queue is predictable. */
  agentIds: string[];
  /** True when no mention narrowed the fan-out. */
  broadcast: boolean;
}

function toRoom(
  row: RoomRow,
  members: CoordinationRoomMember[],
  transcriptIssueIdentifier: string | null,
): CoordinationRoom {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    description: row.description,
    status: row.status as CoordinationRoom["status"],
    transcriptIssueId: row.transcriptIssueId,
    transcriptIssueIdentifier,
    projectId: row.projectId,
    repoFullNames: row.repoFullNames ?? [],
    workspaceRootPath: row.workspaceRootPath,
    members,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}

export function coordinationRoomService(
  db: Db,
  deps: { wakeup?: CoordinationRoomWakeup } = {},
) {
  const issuesSvc = issueService(db);

  /**
   * `executor` lets a caller inside a transaction read its own uncommitted
   * writes. Reading through `db` from inside `create`'s transaction would see
   * the members as absent and silently return an empty room.
   */
  async function loadMembers(
    companyId: string,
    roomId: string,
    executor: Pick<Db, "select"> = db,
  ): Promise<CoordinationRoomMember[]> {
    const rows = await executor
      .select({
        agentId: coordinationRoomMembers.agentId,
        agentName: agents.name,
        worktreePath: coordinationRoomMembers.worktreePath,
        branchName: coordinationRoomMembers.branchName,
        addedAt: coordinationRoomMembers.addedAt,
      })
      .from(coordinationRoomMembers)
      .innerJoin(agents, eq(agents.id, coordinationRoomMembers.agentId))
      .where(
        and(
          eq(coordinationRoomMembers.companyId, companyId),
          eq(coordinationRoomMembers.roomId, roomId),
        ),
      )
      .orderBy(asc(coordinationRoomMembers.addedAt));
    return rows.map((row) => ({
      agentId: row.agentId,
      agentName: row.agentName,
      worktreePath: row.worktreePath,
      branchName: row.branchName,
      addedAt: row.addedAt.toISOString(),
    }));
  }

  async function requireRow(companyId: string, roomId: string): Promise<RoomRow> {
    const row = await db
      .select()
      .from(coordinationRooms)
      .where(and(eq(coordinationRooms.companyId, companyId), eq(coordinationRooms.id, roomId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Room not found");
    return row;
  }

  async function hydrate(row: RoomRow): Promise<CoordinationRoom> {
    const members = await loadMembers(row.companyId, row.id);
    const identifier = row.transcriptIssueId
      ? await db
          .select({ identifier: issues.identifier })
          .from(issues)
          .where(eq(issues.id, row.transcriptIssueId))
          .then((rows) => rows[0]?.identifier ?? null)
      : null;
    return toRoom(row, members, identifier);
  }

  /**
   * Agents whose primary repo is one of `repoFullNames`. This is what makes
   * "open a room from these repos" pre-fill the right members: the repo→agent
   * binding already exists on the agent, so the room does not restate it.
   */
  async function agentsOwningRepos(
    companyId: string,
    repoFullNames: readonly string[],
  ): Promise<string[]> {
    if (repoFullNames.length === 0) return [];
    const rows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          inArray(agents.primaryRepoFullName, [...repoFullNames]),
        ),
      );
    return rows.map((row) => row.id);
  }

  async function assertAgentsInCompany(companyId: string, agentIds: readonly string[]) {
    if (agentIds.length === 0) return;
    const rows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, [...agentIds])));
    if (rows.length !== new Set(agentIds).size) {
      // Same 404-shaped refusal the rest of the control plane uses, so a
      // cross-company id cannot be distinguished from a missing one.
      throw notFound("Agent not found");
    }
  }

  /**
   * Resolves who a message wakes.
   *
   * No mention wakes every member; a mention wakes only the named members
   * (a mentioned non-member is ignored rather than silently joining the
   * room). The returned agents are enqueued against the transcript issue and
   * therefore **serialize**: `issues.executionRunId` is stamped per issue
   * under `SELECT … FOR UPDATE`, so they run one at a time and the existing
   * coalesce/defer behaviour absorbs duplicates. Worktrees are unaffected —
   * every member's tree exists concurrently.
   */
  async function planWakeFor(
    companyId: string,
    roomId: string,
    mentionAgentIds: readonly string[],
  ): Promise<RoomWakePlan> {
    const room = await requireRow(companyId, roomId);
    if (room.status !== "open") {
      throw unprocessable("This room is closed.", { code: "coordination_room_closed" });
    }
    if (!room.transcriptIssueId) {
      throw unprocessable("This room has no transcript issue yet.", {
        code: "coordination_room_transcript_missing",
      });
    }
    const members = await loadMembers(companyId, roomId);
    const memberIds = members.map((member) => member.agentId);
    const mentioned = new Set(mentionAgentIds);
    const broadcast = mentioned.size === 0;
    return {
      roomId: room.id,
      transcriptIssueId: room.transcriptIssueId,
      agentIds: broadcast ? memberIds : memberIds.filter((id) => mentioned.has(id)),
      broadcast,
    };
  }

  return {
    list: async (companyId: string): Promise<CoordinationRoom[]> => {
      const rows = await db
        .select()
        .from(coordinationRooms)
        .where(eq(coordinationRooms.companyId, companyId))
        .orderBy(asc(coordinationRooms.name));
      return Promise.all(rows.map(hydrate));
    },

    getById: async (companyId: string, roomId: string): Promise<CoordinationRoom> =>
      hydrate(await requireRow(companyId, roomId)),

    create: async (
      companyId: string,
      input: CreateCoordinationRoom,
    ): Promise<CoordinationRoom> => {
      const seeded = input.seedMembersFromRepos
        ? await agentsOwningRepos(companyId, input.repoFullNames)
        : [];
      const memberIds = Array.from(new Set([...seeded, ...input.agentIds]));
      await assertAgentsInCompany(companyId, input.agentIds);

      return db.transaction(async (tx) => {
        const [room] = await tx
          .insert(coordinationRooms)
          .values({
            companyId,
            name: input.name,
            description: input.description,
            projectId: input.projectId,
            repoFullNames: input.repoFullNames,
          })
          .onConflictDoNothing({
            target: [coordinationRooms.companyId, coordinationRooms.name],
          })
          .returning();
        if (!room) {
          throw conflict(`A room named "${input.name}" already exists.`, {
            code: "coordination_room_name_taken",
          });
        }
        if (memberIds.length > 0) {
          await tx.insert(coordinationRoomMembers).values(
            memberIds.map((agentId) => ({ companyId, roomId: room.id, agentId })),
          );
        }
        if (!input.createTranscriptIssue) {
          return toRoom(room, await loadMembers(companyId, room.id, tx), null);
        }
        // The transcript is an ordinary issue, created through the issue
        // service rather than inserted here, so it gets a real identifier,
        // activity and sequence like every other issue. That identifier is
        // what the thread UI and `taskKey` use.
        //
        // It stays **unassigned**: members are woken through the membership
        // table, so no issue ever carries two assignees.
        const transcript = await issuesSvc.create(
          companyId,
          {
            title: input.name,
            description: transcriptDescription(input),
            status: "todo",
            priority: "medium",
            assigneeAgentId: null,
            assigneeUserId: null,
            // A room may be reopened and posted to for a long time; deduping
            // it against a same-titled issue would attach the wrong thread.
            allowDuplicate: true,
          },
          tx,
        );
        const [withTranscript] = await tx
          .update(coordinationRooms)
          .set({ transcriptIssueId: transcript.id })
          .where(eq(coordinationRooms.id, room.id))
          .returning();
        return toRoom(
          withTranscript ?? room,
          await loadMembers(companyId, room.id, tx),
          transcript.identifier ?? null,
        );
      });
    },

    update: async (
      companyId: string,
      roomId: string,
      input: UpdateCoordinationRoom,
    ): Promise<CoordinationRoom> => {
      const existing = await requireRow(companyId, roomId);
      const closing = input.status === "closed" && existing.status !== "closed";
      const [row] = await db
        .update(coordinationRooms)
        .set({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          ...(input.repoFullNames === undefined ? {} : { repoFullNames: input.repoFullNames }),
          ...(input.workspaceRootPath === undefined
            ? {}
            : { workspaceRootPath: input.workspaceRootPath }),
          // Closing a room stops wakes. It does not touch anyone's primary
          // checkout, and unmerged member branches stay until deleted.
          ...(closing ? { closedAt: new Date() } : {}),
          ...(input.status === "open" ? { closedAt: null } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(coordinationRooms.companyId, companyId), eq(coordinationRooms.id, roomId)))
        .returning();
      if (!row) throw notFound("Room not found");
      return hydrate(row);
    },

    setTranscriptIssue: async (
      companyId: string,
      roomId: string,
      issueId: string,
    ): Promise<CoordinationRoom> => {
      const room = await requireRow(companyId, roomId);
      if (room.transcriptIssueId) {
        throw conflict("This room already has a transcript.", {
          code: "coordination_room_transcript_exists",
        });
      }
      const issue = await db
        .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");
      // The transcript stays unassigned: members are woken through the
      // membership table, so the single-assignee task model is untouched.
      if (issue.assigneeAgentId) {
        throw unprocessable("A room transcript issue must be unassigned.", {
          code: "coordination_room_transcript_assigned",
        });
      }
      const [row] = await db
        .update(coordinationRooms)
        .set({ transcriptIssueId: issueId, updatedAt: new Date() })
        .where(and(eq(coordinationRooms.companyId, companyId), eq(coordinationRooms.id, roomId)))
        .returning();
      if (!row) throw notFound("Room not found");
      return hydrate(row);
    },

    addMember: async (
      companyId: string,
      roomId: string,
      input: AddCoordinationRoomMember,
    ): Promise<CoordinationRoom> => {
      const room = await requireRow(companyId, roomId);
      await assertAgentsInCompany(companyId, [input.agentId]);
      await db
        .insert(coordinationRoomMembers)
        .values({
          companyId,
          roomId: room.id,
          agentId: input.agentId,
          worktreePath: input.worktreePath,
          branchName: input.branchName,
        })
        .onConflictDoUpdate({
          target: [coordinationRoomMembers.roomId, coordinationRoomMembers.agentId],
          set: {
            worktreePath: input.worktreePath,
            branchName: input.branchName,
            updatedAt: new Date(),
          },
        });
      return hydrate(room);
    },

    removeMember: async (
      companyId: string,
      roomId: string,
      agentId: string,
    ): Promise<CoordinationRoom> => {
      const room = await requireRow(companyId, roomId);
      await db
        .delete(coordinationRoomMembers)
        .where(
          and(
            eq(coordinationRoomMembers.companyId, companyId),
            eq(coordinationRoomMembers.roomId, roomId),
            eq(coordinationRoomMembers.agentId, agentId),
          ),
        );
      return hydrate(room);
    },

    planWake: planWakeFor,

    /**
     * Posts a message into the room transcript and wakes the members it names.
     *
     * Mentions come from the body — the board composer writes mention links,
     * exactly as it does for any issue comment — unioned with any ids the
     * caller resolved itself. No mention wakes every member.
     *
     * The wakes are enqueued one at a time, in membership order, so the
     * serialized queue is deterministic rather than whatever order a
     * `Promise.all` happened to resolve in. They serialize regardless:
     * `issues.executionRunId` is stamped per issue under `SELECT … FOR UPDATE`,
     * so members run one after another on the transcript.
     */
    postMessage: async (
      companyId: string,
      roomId: string,
      input: PostCoordinationRoomMessage,
      actor: CoordinationRoomActor,
    ): Promise<CoordinationRoomMessageResult> => {
      if (!deps.wakeup) {
        // A room message that wakes nobody is the room failing at the only
        // thing it does. Fail loudly on the wiring rather than posting a
        // comment and reporting members as woken when nothing was queued.
        throw new Error(
          "coordinationRoomService requires a wakeup dependency to post room messages",
        );
      }
      const bodyMentions = await issuesSvc
        .findMentionedAgents(companyId, input.body)
        .catch((err) => {
          // A mention that cannot be resolved must not swallow the message.
          // Falling back to "no mention parsed" means the room broadcasts,
          // which wakes a superset of the intended members rather than none.
          logger.warn({ err, roomId }, "failed to resolve room message @-mentions");
          return [] as string[];
        });
      const plan = await planWakeFor(companyId, roomId, [
        ...bodyMentions,
        ...input.mentionAgentIds,
      ]);

      const comment = await issuesSvc.addComment(
        plan.transcriptIssueId,
        input.body,
        {
          agentId: actor.actorType === "agent" ? actor.agentId ?? actor.actorId ?? undefined : undefined,
          userId: actor.actorType === "user" ? actor.actorId ?? undefined : undefined,
          runId: actor.runId ?? null,
        },
        { authorType: actor.actorType === "agent" ? "agent" : "user" },
      );

      const woke: string[] = [];
      for (const agentId of plan.agentIds) {
        // An agent does not wake itself on its own message.
        if (actor.actorType === "agent" && actor.actorId === agentId) continue;
        try {
          await deps.wakeup(agentId, {
            source: "automation",
            triggerDetail: "system",
            reason: ROOM_WAKE_REASON,
            payload: { issueId: plan.transcriptIssueId, commentId: comment.id },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: plan.transcriptIssueId,
              taskId: plan.transcriptIssueId,
              commentId: comment.id,
              wakeCommentId: comment.id,
              wakeReason: ROOM_WAKE_REASON,
              source: ROOM_WAKE_SOURCE,
              // Additive, and read by nothing that decides anything. It is
              // here so a run can tell which room it was woken for.
              coordinationRoomId: plan.roomId,
              coordinationRoomBroadcast: plan.broadcast,
            },
          });
          woke.push(agentId);
        } catch (err) {
          // One member's budget hard-stop or pause must not stop the rest of
          // the room being woken, and the message is already posted.
          logger.warn(
            { err, roomId, agentId, issueId: plan.transcriptIssueId },
            "failed to wake coordination room member",
          );
        }
      }

      return {
        commentId: comment.id,
        roomId: plan.roomId,
        transcriptIssueId: plan.transcriptIssueId,
        wokeAgentIds: woke,
        broadcast: plan.broadcast,
      };
    },

    /** Rooms an agent belongs to, for the agent detail screen. */
    listForAgent: async (companyId: string, agentId: string): Promise<CoordinationRoom[]> => {
      const rows = await db
        .select({ room: coordinationRooms })
        .from(coordinationRoomMembers)
        .innerJoin(coordinationRooms, eq(coordinationRooms.id, coordinationRoomMembers.roomId))
        .where(
          and(
            eq(coordinationRoomMembers.companyId, companyId),
            eq(coordinationRoomMembers.agentId, agentId),
          ),
        )
        .orderBy(asc(coordinationRooms.name));
      return Promise.all(rows.map((row) => hydrate(row.room)));
    },
  };
}

export type CoordinationRoomService = ReturnType<typeof coordinationRoomService>;
