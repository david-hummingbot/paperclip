import { z } from "zod";
import { COORDINATION_ROOM_STATUSES } from "../constants.js";

/** `owner/name`, the form GitHub uses and the form agents carry as a primary repo. */
export const repoFullNameSchema = z
  .string()
  .trim()
  .min(3)
  .max(140)
  .regex(
    /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/,
    "Repositories are written as owner/name.",
  );

export const coordinationRoomStatusSchema = z.enum(COORDINATION_ROOM_STATUSES);

export const createCoordinationRoomSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(4000).nullable().default(null),
    projectId: z.string().uuid().nullable().default(null),
    /**
     * Repositories the effort spans. Opening a room from these pre-fills the
     * agents that own them, which is why the create payload accepts repos and
     * members independently: the caller may take the suggestion or not.
     */
    repoFullNames: z.array(repoFullNameSchema).max(50).default([]),
    /** Members to seed. An empty room is valid and can be filled later. */
    agentIds: z.array(z.string().uuid()).max(50).default([]),
    /**
     * Whether to derive members from `repoFullNames` by matching each agent's
     * `primaryRepoFullName`. Explicit `agentIds` are added on top.
     */
    seedMembersFromRepos: z.boolean().default(true),
  })
  .strict();
export type CreateCoordinationRoom = z.infer<typeof createCoordinationRoomSchema>;

export const updateCoordinationRoomSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(4000).nullable(),
    status: coordinationRoomStatusSchema,
    projectId: z.string().uuid().nullable(),
    repoFullNames: z.array(repoFullNameSchema).max(50),
    workspaceRootPath: z.string().trim().min(1).max(4096).nullable(),
  })
  .strict()
  .partial()
  .refine((value) => Object.keys(value).length > 0, "No fields to update.");
export type UpdateCoordinationRoom = z.infer<typeof updateCoordinationRoomSchema>;

export const addCoordinationRoomMemberSchema = z
  .object({
    agentId: z.string().uuid(),
    worktreePath: z.string().trim().min(1).max(4096).nullable().default(null),
    branchName: z.string().trim().min(1).max(320).nullable().default(null),
  })
  .strict();
export type AddCoordinationRoomMember = z.infer<typeof addCoordinationRoomMemberSchema>;

/**
 * A message posted into the room transcript.
 *
 * With no mentions this wakes every member; with mentions only those named.
 * Either way the wakes serialize on the transcript issue's execution lock, so
 * `mentionAgentIds` changes who is queued, not how many run at once.
 */
export const postCoordinationRoomMessageSchema = z
  .object({
    body: z.string().trim().min(1).max(100_000),
    mentionAgentIds: z.array(z.string().uuid()).max(50).default([]),
  })
  .strict();
export type PostCoordinationRoomMessage = z.infer<typeof postCoordinationRoomMessageSchema>;

export interface CoordinationRoomMember {
  agentId: string;
  agentName: string;
  worktreePath: string | null;
  branchName: string | null;
  addedAt: string;
}

export interface CoordinationRoom {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  status: z.infer<typeof coordinationRoomStatusSchema>;
  transcriptIssueId: string | null;
  transcriptIssueIdentifier: string | null;
  projectId: string | null;
  repoFullNames: string[];
  workspaceRootPath: string | null;
  members: CoordinationRoomMember[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}
