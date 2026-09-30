import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { z } from "zod";
import { AGENT_COMPUTE_PLACEMENTS } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { agentComputerService } from "../services/agent-computer.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

const setPlacementSchema = z
  .object({
    placement: z.enum(AGENT_COMPUTE_PLACEMENTS),
    image: z.string().trim().min(1).max(512).optional(),
    workspacePath: z.string().trim().min(1).max(4096).optional(),
    user: z.string().trim().min(1).max(128).nullable().optional(),
    memoryLimit: z.string().trim().min(1).max(32).nullable().optional(),
    cpuLimit: z.string().trim().min(1).max(32).nullable().optional(),
    dockerContext: z.string().trim().min(1).max(128).nullable().optional(),
    environmentId: z.string().uuid().nullable().optional(),
  })
  .strict();

const terminateSchema = z
  .object({
    // Off by default: reclaiming the container must not silently destroy
    // uncommitted work on its volume.
    removeVolume: z.boolean().default(false),
  })
  .strict();

export function agentComputerRoutes(db: Db) {
  const router = Router();
  const svc = agentComputerService(db);

  router.get("/companies/:companyId/agents/:agentId/computer", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.get(companyId, req.params.agentId as string));
  });

  router.put(
    "/companies/:companyId/agents/:agentId/computer",
    validate(setPlacementSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const agentId = req.params.agentId as string;
      const computer = await svc.setPlacement(companyId, agentId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "agent.computer_changed",
        entityType: "agent",
        entityId: agentId,
        details: { placement: computer.placement, environmentId: computer.environmentId },
      });
      res.json(computer);
    },
  );

  router.post("/companies/:companyId/agents/:agentId/computer/start", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.startContainer(companyId, req.params.agentId as string));
  });

  router.post("/companies/:companyId/agents/:agentId/computer/pause", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const agentId = req.params.agentId as string;
    const result = await svc.pauseContainer(companyId, agentId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "agent.computer_paused",
      entityType: "agent",
      entityId: agentId,
      details: { containerName: result.containerName },
    });
    res.json(result);
  });

  router.post(
    "/companies/:companyId/agents/:agentId/computer/terminate",
    validate(terminateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const agentId = req.params.agentId as string;
      const result = await svc.terminateContainer(companyId, agentId, {
        removeVolume: req.body.removeVolume,
      });
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "agent.computer_terminated",
        entityType: "agent",
        entityId: agentId,
        details: { containerName: result.containerName, volumeRemoved: result.volumeRemoved },
      });
      res.json(result);
    },
  );

  return router;
}
