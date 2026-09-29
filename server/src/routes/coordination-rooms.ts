import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  addCoordinationRoomMemberSchema,
  createCoordinationRoomSchema,
  postCoordinationRoomMessageSchema,
  updateCoordinationRoomSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { coordinationRoomService } from "../services/coordination-rooms.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function coordinationRoomRoutes(db: Db) {
  const router = Router();
  const svc = coordinationRoomService(db);

  router.get("/companies/:companyId/rooms", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId));
  });

  router.get("/companies/:companyId/rooms/:roomId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.getById(companyId, req.params.roomId as string));
  });

  router.post(
    "/companies/:companyId/rooms",
    validate(createCoordinationRoomSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const room = await svc.create(companyId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "coordination_room.created",
        entityType: "coordination_room",
        entityId: room.id,
        details: { name: room.name, memberCount: room.members.length },
      });
      res.status(201).json(room);
    },
  );

  router.patch(
    "/companies/:companyId/rooms/:roomId",
    validate(updateCoordinationRoomSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const room = await svc.update(companyId, req.params.roomId as string, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "coordination_room.updated",
        entityType: "coordination_room",
        entityId: room.id,
        details: { name: room.name, status: room.status },
      });
      res.json(room);
    },
  );

  router.post(
    "/companies/:companyId/rooms/:roomId/members",
    validate(addCoordinationRoomMemberSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const roomId = req.params.roomId as string;
      const room = await svc.addMember(companyId, roomId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "coordination_room.member_added",
        entityType: "coordination_room",
        entityId: roomId,
        details: { agentId: req.body.agentId },
      });
      res.status(201).json(room);
    },
  );

  router.delete("/companies/:companyId/rooms/:roomId/members/:agentId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const roomId = req.params.roomId as string;
    const agentId = req.params.agentId as string;
    const room = await svc.removeMember(companyId, roomId, agentId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "coordination_room.member_removed",
      entityType: "coordination_room",
      entityId: roomId,
      details: { agentId },
    });
    res.json(room);
  });

  /**
   * Resolves who a message would wake, without posting it.
   *
   * Exposed on its own because the fan-out is the part of a room that is easy
   * to get wrong: with no mention every member is queued, and they run one at
   * a time against the transcript issue's execution lock. Letting the board
   * show that before sending keeps the serialization visible rather than
   * surprising.
   */
  router.post(
    "/companies/:companyId/rooms/:roomId/wake-plan",
    validate(postCoordinationRoomMessageSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const plan = await svc.planWake(
        companyId,
        req.params.roomId as string,
        req.body.mentionAgentIds,
      );
      res.json(plan);
    },
  );

  return router;
}
