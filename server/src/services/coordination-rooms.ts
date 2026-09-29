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
  CreateCoordinationRoom,
  UpdateCoordinationRoom,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

type RoomRow = typeof coordinationRooms.$inferSelect;

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

export function coordinationRoomService(db: Db) {
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
        return toRoom(room, await loadMembers(companyId, room.id, tx), null);
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
    planWake: async (
      companyId: string,
      roomId: string,
      mentionAgentIds: readonly string[],
    ): Promise<RoomWakePlan> => {
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
