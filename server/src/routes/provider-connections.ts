import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  PROVIDER_PRESET_DEFINITIONS,
  createProviderConnectionSchema,
  updateProviderConnectionSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { providerConnectionService } from "../services/provider-connections.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function providerConnectionRoutes(db: Db) {
  const router = Router();
  const svc = providerConnectionService(db);

  /**
   * The preset catalog is instance-level reference data: base URLs and wire
   * formats, no company or user content, so it needs no company scope.
   */
  router.get("/provider-presets", async (_req, res) => {
    res.json({ presets: PROVIDER_PRESET_DEFINITIONS });
  });

  router.get("/companies/:companyId/provider-connections", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId));
  });

  router.get("/companies/:companyId/provider-connections/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.getById(companyId, req.params.id as string));
  });

  router.post(
    "/companies/:companyId/provider-connections",
    validate(createProviderConnectionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const connection = await svc.create(companyId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "provider_connection.created",
        entityType: "provider_connection",
        entityId: connection.id,
        // Base URL is operator configuration, not a credential; the key lives
        // in the secret store and is never in this record.
        details: { name: connection.name, preset: connection.preset, baseUrl: connection.baseUrl },
      });
      res.status(201).json(connection);
    },
  );

  router.patch(
    "/companies/:companyId/provider-connections/:id",
    validate(updateProviderConnectionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const connection = await svc.update(companyId, req.params.id as string, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "provider_connection.updated",
        entityType: "provider_connection",
        entityId: connection.id,
        details: { name: connection.name, baseUrl: connection.baseUrl },
      });
      res.json(connection);
    },
  );

  router.delete("/companies/:companyId/provider-connections/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const id = req.params.id as string;
    const result = await svc.remove(companyId, id);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "provider_connection.deleted",
      entityType: "provider_connection",
      entityId: id,
      details: { detachedAgentCount: result.detachedAgentIds.length },
    });
    res.json(result);
  });

  return router;
}
