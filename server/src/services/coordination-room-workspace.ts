import { and, asc, eq } from "drizzle-orm";
import fs from "node:fs/promises";
import path from "node:path";
import {
  agents,
  coordinationRoomMembers,
  coordinationRooms,
  issues,
  projectWorkspaces,
  type Db,
} from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { realizeExecutionWorkspace } from "./workspace-runtime.js";

/**
 * Per-member git worktrees for a coordination room.
 *
 * The room workspace is one shared checkout for the effort, separate from every
 * member's everyday checkout. Each member works in their own tree cut from it,
 * so the condor agent's tree is not the hummingbot-api agent's tree and both
 * can hold uncommitted work at once — only *runs* serialize, on the transcript
 * issue's execution lock.
 *
 * Nothing here is new worktree machinery. `realizeExecutionWorkspace` already
 * creates a branch and tree from a base checkout, already derives both from a
 * template that includes `{{agent.name}}`, and already carries the coherence
 * checks, reuse paths and ownership rules that have been debugged against real
 * repositories. A room supplies the base checkout and the template; everything
 * after that is the existing path.
 */

/** The branch a member works on, and therefore the directory name of their tree. */
export const ROOM_BRANCH_TEMPLATE = "room/{{issue.identifier}}/{{agent.name}}";

export interface RoomMemberWorktree {
  agentId: string;
  agentName: string;
  worktreePath: string;
  branchName: string;
  created: boolean;
}

export interface RoomWorkspaceResult {
  roomId: string;
  workspaceRootPath: string;
  members: RoomMemberWorktree[];
  /** Members skipped, and why. A skip never fails the others. */
  skipped: { agentId: string; agentName: string; reason: string }[];
}

type RoomRow = typeof coordinationRooms.$inferSelect;

async function isDirectory(target: string): Promise<boolean> {
  return fs
    .stat(target)
    .then((entry) => entry.isDirectory())
    .catch(() => false);
}

export function coordinationRoomWorkspaceService(db: Db) {
  async function requireRoom(companyId: string, roomId: string): Promise<RoomRow> {
    const row = await db
      .select()
      .from(coordinationRooms)
      .where(and(eq(coordinationRooms.companyId, companyId), eq(coordinationRooms.id, roomId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Room not found");
    return row;
  }

  /**
   * Where the room's shared checkout lives.
   *
   * An explicit `workspaceRootPath` wins. Otherwise a room linked to a project
   * borrows that project's primary workspace, which is the checkout the effort's
   * repos already live in — so the common case needs no hand-set path.
   *
   * Paperclip does not clone the room's repos itself yet; see
   * `doc/coordination-rooms.md`.
   */
  async function resolveWorkspaceRoot(room: RoomRow): Promise<string> {
    const configured = room.workspaceRootPath?.trim();
    if (configured) return configured;
    if (!room.projectId) {
      throw unprocessable(
        "This room has no workspace. Set workspaceRootPath to a git checkout, or link the room to a project.",
        { code: "coordination_room_workspace_missing" },
      );
    }
    const workspace = await db
      .select({ cwd: projectWorkspaces.cwd })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.projectId, room.projectId))
      .orderBy(asc(projectWorkspaces.createdAt))
      .then((rows) => rows.find((row) => row.cwd?.trim()) ?? null);
    const cwd = workspace?.cwd?.trim();
    if (!cwd) {
      throw unprocessable(
        "The room's project has no checkout on disk yet. Set workspaceRootPath explicitly, or open the project workspace first.",
        { code: "coordination_room_workspace_missing" },
      );
    }
    return cwd;
  }

  async function transcriptRef(room: RoomRow) {
    if (!room.transcriptIssueId) {
      // The branch template names the transcript, and the transcript is also
      // what scopes a member's session to this room. A room without one has no
      // stable name to cut branches under.
      throw unprocessable("This room has no transcript issue yet.", {
        code: "coordination_room_transcript_missing",
      });
    }
    const issue = await db
      .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
      .from(issues)
      .where(eq(issues.id, room.transcriptIssueId))
      .then((rows) => rows[0] ?? null);
    if (!issue) throw notFound("Issue not found");
    // `renderWorkspaceTemplate` substitutes an absent identifier with the empty
    // string, which would render `room//<agent>` — git rejects an empty path
    // segment in a ref name, so every member's tree would fail to create. Issues
    // created through the issue service always have an identifier; coalescing
    // here means one that somehow does not still produces a valid branch.
    const identifier = issue.identifier?.trim() || issue.id;
    return { id: issue.id, identifier, title: issue.title };
  }

  /**
   * Creates (or adopts) one member's tree and records it on the member row.
   *
   * `realizeExecutionWorkspace` is idempotent for a branch it has already cut:
   * an existing tree on the right branch is reused rather than replaced, so
   * calling this on every room wake is safe and cheap.
   */
  async function realizeMemberWorktree(input: {
    companyId: string;
    roomId: string;
    workspaceRootPath: string;
    issue: { id: string; identifier: string | null; title: string | null };
    agent: { id: string; name: string };
  }): Promise<RoomMemberWorktree> {
    const realized = await realizeExecutionWorkspace({
      db,
      base: {
        baseCwd: input.workspaceRootPath,
        // Not a project checkout and not the agent's home: the room supplies
        // this cwd, and the member's session is keyed to the room's transcript.
        source: "task_session",
        projectId: null,
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: ROOM_BRANCH_TEMPLATE,
        },
      },
      issue: { id: input.issue.id, identifier: input.issue.identifier, title: input.issue.title },
      agent: { id: input.agent.id, name: input.agent.name, companyId: input.companyId },
    });
    if (!realized.worktreePath || !realized.branchName) {
      // Only reachable if the strategy were ignored; make it loud rather than
      // recording a null tree that the heartbeat would silently skip.
      throw unprocessable("The room workspace did not produce a worktree.", {
        code: "coordination_room_worktree_failed",
      });
    }
    await db
      .update(coordinationRoomMembers)
      .set({
        worktreePath: realized.worktreePath,
        branchName: realized.branchName,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(coordinationRoomMembers.companyId, input.companyId),
          eq(coordinationRoomMembers.roomId, input.roomId),
          eq(coordinationRoomMembers.agentId, input.agent.id),
        ),
      );
    return {
      agentId: input.agent.id,
      agentName: input.agent.name,
      worktreePath: realized.worktreePath,
      branchName: realized.branchName,
      created: realized.created,
    };
  }

  return {
    /**
     * Gives every member of the room a tree, and records the root on the room.
     *
     * Idempotent: a member who already has a coherent tree keeps it. One
     * member's failure is reported and skipped rather than failing the rest —
     * a room of three should not be unusable because one agent's branch is in a
     * state that needs an operator.
     */
    ensureRoomWorkspace: async (
      companyId: string,
      roomId: string,
    ): Promise<RoomWorkspaceResult> => {
      const room = await requireRoom(companyId, roomId);
      const workspaceRootPath = await resolveWorkspaceRoot(room);
      if (!(await isDirectory(workspaceRootPath))) {
        throw unprocessable(
          `The room workspace path "${workspaceRootPath}" is not a directory on this host.`,
          { code: "coordination_room_workspace_missing" },
        );
      }
      if (!(await isDirectory(path.join(workspaceRootPath, ".git")))) {
        // `git worktree add` needs a repository. Saying so here beats a raw git
        // failure per member.
        throw unprocessable(
          `The room workspace path "${workspaceRootPath}" is not a git checkout.`,
          { code: "coordination_room_workspace_not_git" },
        );
      }
      const issue = await transcriptRef(room);

      const members = await db
        .select({
          agentId: coordinationRoomMembers.agentId,
          agentName: agents.name,
          computePlacement: agents.computePlacement,
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

      const realized: RoomMemberWorktree[] = [];
      const skipped: RoomWorkspaceResult["skipped"] = [];
      for (const member of members) {
        if (member.computePlacement !== "shared") {
          // A tree cut on the Paperclip host is not on the agent's machine, and
          // the remote transports discard the host path outright
          // (`adapterExecutionTargetRemoteCwd`), so the agent would run in its
          // container's fixed workspace while we claimed it had a room tree.
          // Refuse instead of recording a path that is a lie.
          skipped.push({
            agentId: member.agentId,
            agentName: member.agentName,
            reason: `${member.agentName} runs on a ${member.computePlacement} computer; room worktrees are only created on the Paperclip host.`,
          });
          continue;
        }
        try {
          realized.push(
            await realizeMemberWorktree({
              companyId,
              roomId,
              workspaceRootPath,
              issue,
              agent: { id: member.agentId, name: member.agentName },
            }),
          );
        } catch (err) {
          logger.warn(
            { err, roomId, agentId: member.agentId },
            "failed to create coordination room member worktree",
          );
          skipped.push({
            agentId: member.agentId,
            agentName: member.agentName,
            reason: err instanceof Error ? err.message : "Worktree creation failed.",
          });
        }
      }

      if (room.workspaceRootPath !== workspaceRootPath) {
        // Record the resolved root so later calls, and the board, agree on it
        // without re-deriving it from the project.
        await db
          .update(coordinationRooms)
          .set({ workspaceRootPath, updatedAt: new Date() })
          .where(eq(coordinationRooms.id, roomId));
      }

      return { roomId, workspaceRootPath, members: realized, skipped };
    },

    /**
     * The member's tree for a room, or null when they have none.
     *
     * The heartbeat calls this on a room wake to set the run's cwd. It returns
     * null rather than throwing for every reason a member might not have a tree
     * — no room workspace, a docker member, a tree an operator removed — so a
     * room wake degrades to the agent's ordinary cwd instead of failing to run.
     */
    findMemberWorktree: async (input: {
      companyId: string;
      roomId: string;
      agentId: string;
    }): Promise<{ worktreePath: string; branchName: string | null } | null> => {
      const row = await db
        .select({
          worktreePath: coordinationRoomMembers.worktreePath,
          branchName: coordinationRoomMembers.branchName,
        })
        .from(coordinationRoomMembers)
        .where(
          and(
            eq(coordinationRoomMembers.companyId, input.companyId),
            eq(coordinationRoomMembers.roomId, input.roomId),
            eq(coordinationRoomMembers.agentId, input.agentId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      const worktreePath = row?.worktreePath?.trim();
      if (!worktreePath) return null;
      // The row is a record of what was created, not proof it still exists. An
      // operator who removed the tree should get the ordinary cwd, not a run
      // that starts in a missing directory.
      if (!(await isDirectory(worktreePath))) return null;
      return { worktreePath, branchName: row?.branchName ?? null };
    },
  };
}

export type CoordinationRoomWorkspaceService = ReturnType<
  typeof coordinationRoomWorkspaceService
>;
