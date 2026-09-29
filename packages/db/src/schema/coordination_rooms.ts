import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";

/**
 * A coordination room is a company-scoped effort with a member list.
 *
 * Standing work stays one agent per repo: a hummingbot-api pull request wakes
 * the hummingbot-api agent alone, on its primary checkout. A room is for the
 * cross-repo effort that needs two or three of those agents at once, and it is
 * deliberately *not* modelled on a chat channel — the transcript is an issue,
 * so comments, activity, budgets and the existing thread UI all keep working.
 *
 * The transcript issue stays **unassigned**. Members are woken through
 * `coordination_room_members`, never by assignment, so the single-assignee
 * task model is untouched.
 *
 * Runs serialize. `issues.executionRunId` is stamped per issue under
 * `SELECT … FOR UPDATE`, so two members cannot execute on the transcript issue
 * at the same time; a fan-out wake queues and runs in order, and the existing
 * coalesce and defer behaviour absorbs duplicates. Worktrees are not affected:
 * every member's tree exists concurrently and may hold uncommitted work while
 * another member's run holds the lock.
 */
export const coordinationRooms = pgTable(
  "coordination_rooms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    /** `open` accepts wakes; `closed` keeps the transcript readable and stops them. */
    status: text("status").notNull().default("open"),
    /**
     * The transcript. One issue per room, unassigned, carrying the thread the
     * members read and write. It is also the wake context, which means
     * `deriveTaskKey` falls back to this id and each member automatically gets
     * a session keyed `(company, agent, adapterType, this room)` — no separate
     * room-session table is needed.
     */
    transcriptIssueId: uuid("transcript_issue_id").references(() => issues.id, {
      onDelete: "set null",
    }),
    /** Optional link to the project whose repositories the effort touches. */
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    /**
     * Repositories this effort spans, as `owner/name`. Opening a room from a
     * set of repos pre-fills the agents that own them; members can still be
     * added and removed by hand afterwards.
     */
    repoFullNames: jsonb("repo_full_names").$type<string[]>().notNull().default([]),
    /**
     * The shared integration checkout for the effort, separate from every
     * member's everyday checkout. Each member gets their own worktree and
     * branch inside it (see `coordination_room_members`).
     */
    workspaceRootPath: text("workspace_root_path"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => ({
    companyStatusIdx: index("coordination_rooms_company_status_idx").on(
      table.companyId,
      table.status,
      table.updatedAt,
    ),
    companyNameIdx: uniqueIndex("coordination_rooms_company_name_uniq").on(
      table.companyId,
      table.name,
    ),
    companyIdUq: unique("coordination_rooms_company_id_uq").on(table.companyId, table.id),
    // One room per transcript issue, so a thread can never serve two rooms.
    transcriptIssueIdx: uniqueIndex("coordination_rooms_transcript_issue_uniq")
      .on(table.transcriptIssueId)
      .where(sql`${table.transcriptIssueId} IS NOT NULL`),
    statusCheck: check(
      "coordination_rooms_status_check",
      sql`${table.status} in ('open','closed')`,
    ),
  }),
);

/**
 * Room membership. An agent may belong to many rooms and a room holds many
 * agents, so this is a join table rather than a single `conversationAgentId`
 * of the kind `chat_endpoints.assignedAgentId` uses for external channels.
 *
 * The condor agent can sit in both the api room and the hummingbot room while
 * still reviewing condor pull requests on its own session; all three keep
 * distinct cwds because the session key includes the room's transcript issue.
 */
export const coordinationRoomMembers = pgTable(
  "coordination_room_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    roomId: uuid("room_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    /**
     * This member's own worktree inside the room workspace. One tree and one
     * branch per member: the condor agent's tree is not the hummingbot-api
     * agent's tree. A room wake sets the agent's cwd here. The tree lives on
     * whatever computer the agent already has — a room never allocates a
     * second machine.
     */
    worktreePath: text("worktree_path"),
    branchName: text("branch_name"),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    roomAgentUq: uniqueIndex("coordination_room_members_room_agent_uniq").on(
      table.roomId,
      table.agentId,
    ),
    agentIdx: index("coordination_room_members_company_agent_idx").on(
      table.companyId,
      table.agentId,
    ),
    // Composite foreign keys: a member row cannot join a room or an agent that
    // belongs to another company, which keeps the room company-scoped without
    // a runtime check on every read.
    roomFk: foreignKey({
      columns: [table.companyId, table.roomId],
      foreignColumns: [coordinationRooms.companyId, coordinationRooms.id],
      name: "coordination_room_members_company_room_fk",
    }).onDelete("cascade"),
    agentFk: foreignKey({
      columns: [table.companyId, table.agentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "coordination_room_members_company_agent_fk",
    }).onDelete("cascade"),
  }),
);
