import { and, eq } from "drizzle-orm";
import { agents, environments, type Db } from "@paperclipai/db";
import {
  COMPUTE_PLACEMENT_DRIVER,
  type AgentComputePlacement,
} from "@paperclipai/shared";
import {
  containerNameForAgent,
  ensureContainerRunning,
  inspectContainerState,
  parseDockerExecutionSpec,
  removeContainer,
  stopContainer,
  volumeNameForAgent,
  type ContainerState,
} from "@paperclipai/adapter-utils/docker";
import { conflict, notFound, unprocessable } from "../errors.js";
import { normalizeEnvironmentConfig } from "./environment-config.js";
import { logger } from "../middleware/logger.js";

/**
 * An agent's computer: the machine its runs execute on.
 *
 * `shared` means no dedicated machine — runs use the project cwd on the
 * Paperclip host, which is what every agent does today. `docker` is one
 * long-lived container that belongs to this agent. `ssh` is an existing host.
 *
 * The container and its volume are named from the agent id, so they survive a
 * rename and cannot collide between agents. The environment row that describes
 * the machine carries `companyId` and `agentId`, so another company can never
 * select it.
 */

export interface AgentComputer {
  agentId: string;
  placement: AgentComputePlacement;
  environmentId: string | null;
  /** Live container state, for a `docker` placement. */
  containerState?: ContainerState;
  containerName?: string;
  image?: string;
}

function dockerSpecFor(input: {
  agentId: string;
  config: Record<string, unknown>;
}) {
  const spec = parseDockerExecutionSpec({
    ...input.config,
    containerName:
      typeof input.config.containerName === "string" && input.config.containerName
        ? input.config.containerName
        : containerNameForAgent(input.agentId),
    volumeName:
      typeof input.config.volumeName === "string" && input.config.volumeName
        ? input.config.volumeName
        : volumeNameForAgent(input.agentId),
  });
  if (!spec) {
    throw unprocessable("This agent's Docker environment has no image configured.", {
      code: "agent_computer_image_missing",
    });
  }
  return spec;
}

export function agentComputerService(db: Db) {
  async function requireAgent(companyId: string, agentId: string) {
    const row = await db
      .select({
        id: agents.id,
        name: agents.name,
        computePlacement: agents.computePlacement,
        defaultEnvironmentId: agents.defaultEnvironmentId,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Agent not found");
    return row;
  }

  async function loadOwnedEnvironment(companyId: string, agentId: string) {
    return db
      .select()
      .from(environments)
      .where(and(eq(environments.companyId, companyId), eq(environments.agentId, agentId)))
      .then((rows) => rows[0] ?? null);
  }

  return {
    get: async (companyId: string, agentId: string): Promise<AgentComputer> => {
      const agent = await requireAgent(companyId, agentId);
      const placement = agent.computePlacement as AgentComputePlacement;
      const environment = await loadOwnedEnvironment(companyId, agentId);

      if (placement !== "docker" || !environment) {
        return {
          agentId,
          placement,
          environmentId: agent.defaultEnvironmentId ?? environment?.id ?? null,
        };
      }

      const spec = dockerSpecFor({ agentId, config: environment.config ?? {} });
      // A docker CLI that is missing or a daemon that is down must not make
      // reading an agent's settings fail; report the state as unknown instead.
      let containerState: ContainerState = "missing";
      try {
        containerState = await inspectContainerState(spec);
      } catch (err) {
        logger.warn({ err, agentId }, "could not inspect agent container");
      }
      return {
        agentId,
        placement,
        environmentId: environment.id,
        containerState,
        containerName: spec.containerName,
        image: spec.image,
      };
    },

    /**
     * Sets an agent's compute placement, creating or removing the environment
     * row that describes its machine.
     *
     * Moving to `shared` detaches and deletes the owned environment row but
     * deliberately leaves the container in place — removing it would destroy
     * uncommitted work on what may be a temporary change of placement. Use
     * `terminateContainer` to reclaim it explicitly.
     */
    setPlacement: async (
      companyId: string,
      agentId: string,
      input: {
        placement: AgentComputePlacement;
        /** Required for `docker`. */
        image?: string;
        workspacePath?: string;
        user?: string | null;
        memoryLimit?: string | null;
        cpuLimit?: string | null;
        dockerContext?: string | null;
        /** Required for `ssh`: an existing environment this agent will own. */
        environmentId?: string | null;
      },
    ): Promise<AgentComputer> => {
      const agent = await requireAgent(companyId, agentId);
      const existing = await loadOwnedEnvironment(companyId, agentId);

      if (input.placement === "shared") {
        if (existing) {
          await db.delete(environments).where(eq(environments.id, existing.id));
        }
        await db
          .update(agents)
          .set({
            computePlacement: "shared",
            defaultEnvironmentId: null,
            updatedAt: new Date(),
          })
          .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)));
        return { agentId, placement: "shared", environmentId: null };
      }

      if (input.placement === "ssh") {
        if (!input.environmentId) {
          throw unprocessable("An SSH placement needs an environment to own.", {
            code: "agent_computer_environment_required",
          });
        }
        const target = await db
          .select()
          .from(environments)
          .where(eq(environments.id, input.environmentId))
          .then((rows) => rows[0] ?? null);
        if (!target || target.driver !== "ssh") throw notFound("Environment not found");
        // Ownership is exclusive: an SSH host that is one agent's computer
        // cannot also be another's.
        if (target.agentId && target.agentId !== agentId) {
          throw conflict("That environment already belongs to another agent.", {
            code: "agent_computer_environment_taken",
          });
        }
        await db
          .update(environments)
          .set({ companyId, agentId, updatedAt: new Date() })
          .where(eq(environments.id, target.id));
        await db
          .update(agents)
          .set({
            computePlacement: "ssh",
            defaultEnvironmentId: target.id,
            updatedAt: new Date(),
          })
          .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)));
        return { agentId, placement: "ssh", environmentId: target.id };
      }

      const image = input.image?.trim();
      if (!image) {
        throw unprocessable("A Docker placement needs an image.", {
          code: "agent_computer_image_required",
        });
      }
      const config = normalizeEnvironmentConfig({
        driver: "docker",
        config: {
          image,
          ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
          user: input.user ?? null,
          memoryLimit: input.memoryLimit ?? null,
          cpuLimit: input.cpuLimit ?? null,
          dockerContext: input.dockerContext ?? null,
          containerName: containerNameForAgent(agentId),
          volumeName: volumeNameForAgent(agentId),
        },
      });

      const environmentId = existing
        ? existing.id
        : await db
            .insert(environments)
            .values({
              // Names are unique per company, and the agent name is the one an
              // operator will recognise on the environments screen.
              name: `${agent.name} computer`,
              description: `Docker container for ${agent.name}`,
              driver: "docker",
              companyId,
              agentId,
              config,
            })
            .returning({ id: environments.id })
            .then((rows) => rows[0]!.id);

      if (existing) {
        await db
          .update(environments)
          .set({ driver: "docker", config, updatedAt: new Date() })
          .where(eq(environments.id, existing.id));
      }

      await db
        .update(agents)
        .set({
          computePlacement: "docker",
          defaultEnvironmentId: environmentId,
          updatedAt: new Date(),
        })
        .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)));

      return {
        agentId,
        placement: "docker",
        environmentId,
        containerName: containerNameForAgent(agentId),
        image,
      };
    },

    /** Creates the container if needed and leaves it running. */
    startContainer: async (companyId: string, agentId: string) => {
      const environment = await loadOwnedEnvironment(companyId, agentId);
      if (!environment || environment.driver !== "docker") {
        throw unprocessable("This agent has no Docker computer.", {
          code: "agent_computer_not_docker",
        });
      }
      const spec = dockerSpecFor({ agentId, config: environment.config ?? {} });
      const result = await ensureContainerRunning(spec);
      return { containerName: spec.containerName, ...result };
    },

    /** Stops the container, keeping it and its volume. This is agent pause. */
    pauseContainer: async (companyId: string, agentId: string) => {
      const environment = await loadOwnedEnvironment(companyId, agentId);
      if (!environment || environment.driver !== "docker") {
        throw unprocessable("This agent has no Docker computer.", {
          code: "agent_computer_not_docker",
        });
      }
      const spec = dockerSpecFor({ agentId, config: environment.config ?? {} });
      await stopContainer(spec);
      return { containerName: spec.containerName, state: "exited" as const };
    },

    /**
     * Removes the container. The volume is kept unless `removeVolume` is set,
     * so terminating does not silently destroy uncommitted work.
     */
    terminateContainer: async (
      companyId: string,
      agentId: string,
      options: { removeVolume?: boolean } = {},
    ) => {
      const environment = await loadOwnedEnvironment(companyId, agentId);
      if (!environment || environment.driver !== "docker") {
        throw unprocessable("This agent has no Docker computer.", {
          code: "agent_computer_not_docker",
        });
      }
      const spec = dockerSpecFor({ agentId, config: environment.config ?? {} });
      await removeContainer(spec, {
        ...(options.removeVolume === undefined ? {} : { removeVolume: options.removeVolume }),
      });
      return {
        containerName: spec.containerName,
        state: "missing" as const,
        volumeRemoved: options.removeVolume === true,
      };
    },
  };
}

export type AgentComputerService = ReturnType<typeof agentComputerService>;

/** The environment driver a placement requires, or null for `shared`. */
export function driverForPlacement(placement: AgentComputePlacement) {
  return COMPUTE_PLACEMENT_DRIVER[placement];
}
