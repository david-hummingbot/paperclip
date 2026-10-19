import { spawn } from "node:child_process";

/**
 * One long-lived container per agent.
 *
 * This is a first-class driver rather than a cloud-sandbox plugin because the
 * lifetimes differ: a sandbox lease is short by design and the provider owns
 * reclaiming it, whereas an agent's container is created on first use and
 * reused across heartbeats so its home directory, tool installs and worktrees
 * survive between runs.
 *
 * Every operation shells out to the `docker` CLI rather than talking to the
 * daemon socket. The CLI is what an operator already has configured — remote
 * contexts, rootless daemons, Colima, Docker Desktop — so borrowing it means
 * the driver works wherever `docker` already works, with no second source of
 * connection configuration to keep in sync.
 */

export interface DockerExecutionSpec {
  /** Container name. Derived from the agent so it is stable across runs. */
  containerName: string;
  image: string;
  /** Absolute path inside the container where workspaces live. */
  workspacePath: string;
  /** Container user, for example "node" or "1000:1000". */
  user?: string | null;
  /** Hard memory limit, in Docker's own notation, for example "4g". */
  memoryLimit?: string | null;
  /** CPU limit as a decimal count, for example "2" or "1.5". */
  cpuLimit?: string | null;
  /** Named volume mounted at `workspacePath` so work survives re-creation. */
  volumeName?: string | null;
  /** Extra `--env KEY=VALUE` pairs applied at container creation. */
  createEnv?: Record<string, string>;
  /** Optional docker CLI context or host, passed as `--context`. */
  dockerContext?: string | null;
}

export interface DockerCommandResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

const DEFAULT_WORKSPACE_PATH = "/workspace";
const DEFAULT_CLI_TIMEOUT_MS = 60_000;

/**
 * Container names must match Docker's own character class, so an agent name
 * cannot be used directly. The id is stable and already unique, which also
 * means renaming an agent does not orphan its container.
 */
export function containerNameForAgent(agentId: string): string {
  const normalized = agentId.replace(/[^a-zA-Z0-9_.-]/g, "").toLowerCase();
  return `paperclip-agent-${normalized}`;
}

export function volumeNameForAgent(agentId: string): string {
  return `${containerNameForAgent(agentId)}-home`;
}

function baseArgs(spec: Pick<DockerExecutionSpec, "dockerContext">): string[] {
  return spec.dockerContext ? ["--context", spec.dockerContext] : [];
}

/** Runs one `docker` CLI invocation and collects its output. */
export async function runDockerCli(
  args: string[],
  options: {
    timeoutMs?: number;
    stdin?: string;
    env?: Record<string, string>;
    cwd?: string;
    onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void> | void;
    onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void> | void;
    signal?: AbortSignal;
  } = {},
): Promise<DockerCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  return new Promise<DockerCommandResult>((resolve, reject) => {
    const child = spawn("docker", args, {
      // The docker CLI reads DOCKER_HOST, DOCKER_CONTEXT and credential
      // helpers from the ambient environment; the caller's env is for the
      // command *inside* the container and is passed with `--env` instead.
      env: process.env,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, timeoutMs)
        : null;

    const onAbort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      void options.onLog?.("stdout", text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      void options.onLog?.("stderr", text);
    });

    child.on("spawn", () => {
      if (child.pid) {
        void options.onSpawn?.({ pid: child.pid, startedAt: new Date().toISOString() });
      }
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      // A missing CLI is the single most common setup failure, and the raw
      // ENOENT does not say which binary was missing.
      if (error.code === "ENOENT") {
        reject(
          new Error(
            "The `docker` command was not found on the Paperclip host. Install Docker, or use a different compute placement for this agent.",
          ),
        );
        return;
      }
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode: timedOut ? null : code,
        signal: signal ?? null,
        timedOut,
        stdout,
        stderr,
      });
    });

    if (options.stdin !== undefined) child.stdin.write(options.stdin);
    child.stdin.end();
  });
}

export type ContainerState = "missing" | "running" | "paused" | "exited";

export async function inspectContainerState(
  spec: DockerExecutionSpec,
): Promise<ContainerState> {
  const result = await runDockerCli([
    ...baseArgs(spec),
    "inspect",
    "--format",
    "{{.State.Status}}",
    spec.containerName,
  ]);
  if (result.exitCode !== 0) return "missing";
  const status = result.stdout.trim();
  if (status === "running") return "running";
  if (status === "paused") return "paused";
  return "exited";
}

/**
 * Brings the agent's container to a running state, creating it on first use.
 *
 * Idempotent by design: the heartbeat calls this before every run and a
 * healthy container short-circuits after one `inspect`. A container that
 * exists but is stopped or paused is restarted rather than replaced, so the
 * work inside it is preserved.
 */
export async function ensureContainerRunning(
  spec: DockerExecutionSpec,
  options: { onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void> | void } = {},
): Promise<{ state: ContainerState; created: boolean }> {
  const state = await inspectContainerState(spec);

  if (state === "running") return { state, created: false };

  if (state === "paused") {
    const unpaused = await runDockerCli([...baseArgs(spec), "unpause", spec.containerName]);
    if (unpaused.exitCode !== 0) {
      throw new Error(`Could not unpause ${spec.containerName}: ${unpaused.stderr.trim()}`);
    }
    return { state: "running", created: false };
  }

  if (state === "exited") {
    const started = await runDockerCli([...baseArgs(spec), "start", spec.containerName]);
    if (started.exitCode !== 0) {
      throw new Error(`Could not start ${spec.containerName}: ${started.stderr.trim()}`);
    }
    return { state: "running", created: false };
  }

  const workspacePath = spec.workspacePath || DEFAULT_WORKSPACE_PATH;
  const createArgs = [
    ...baseArgs(spec),
    "run",
    "--detach",
    "--name",
    spec.containerName,
    // A Paperclip label so an operator can find every container this driver
    // owns without guessing at the name prefix.
    "--label",
    "ai.paperclip.owner=agent",
    "--workdir",
    workspacePath,
    ...(spec.user ? ["--user", spec.user] : []),
    ...(spec.memoryLimit ? ["--memory", spec.memoryLimit] : []),
    ...(spec.cpuLimit ? ["--cpus", spec.cpuLimit] : []),
    ...(spec.volumeName ? ["--volume", `${spec.volumeName}:${workspacePath}`] : []),
    ...Object.entries(spec.createEnv ?? {}).flatMap(([key, value]) => [
      "--env",
      `${key}=${value}`,
    ]),
    spec.image,
    // Hold the container open. The adapter runs through `docker exec`, so the
    // container's own entrypoint must not exit or the agent loses its machine
    // between heartbeats.
    "sleep",
    "infinity",
  ];

  const created = await runDockerCli(createArgs, {
    timeoutMs: 300_000,
    ...(options.onLog ? { onLog: options.onLog } : {}),
  });
  if (created.exitCode !== 0) {
    throw new Error(
      `Could not create container ${spec.containerName} from image ${spec.image}: ${created.stderr.trim()}`,
    );
  }
  return { state: "running", created: true };
}

/** Stops the container but keeps it and its volume. Used by agent pause. */
export async function stopContainer(spec: DockerExecutionSpec): Promise<void> {
  await runDockerCli([...baseArgs(spec), "stop", spec.containerName]);
}

/**
 * Removes the container. The named volume is removed only when
 * `removeVolume` is set, so terminating an agent does not silently destroy
 * uncommitted work unless that is what the caller asked for.
 */
export async function removeContainer(
  spec: DockerExecutionSpec,
  options: { removeVolume?: boolean } = {},
): Promise<void> {
  await runDockerCli([...baseArgs(spec), "rm", "--force", spec.containerName]);
  if (options.removeVolume && spec.volumeName) {
    await runDockerCli([...baseArgs(spec), "volume", "rm", "--force", spec.volumeName]);
  }
}

/** Builds the `docker exec` argv for one command inside the container. */
export function buildExecArgs(input: {
  spec: DockerExecutionSpec;
  command: string;
  args: readonly string[];
  cwd?: string | null;
  env?: Record<string, string>;
  interactive?: boolean;
}): string[] {
  return [
    ...baseArgs(input.spec),
    "exec",
    ...(input.interactive ? ["--interactive"] : []),
    ...(input.spec.user ? ["--user", input.spec.user] : []),
    "--workdir",
    input.cwd || input.spec.workspacePath || DEFAULT_WORKSPACE_PATH,
    ...Object.entries(input.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    input.spec.containerName,
    input.command,
    ...input.args,
  ];
}

export function parseDockerExecutionSpec(value: unknown): DockerExecutionSpec | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const containerName = typeof record.containerName === "string" ? record.containerName : "";
  const image = typeof record.image === "string" ? record.image : "";
  if (!containerName || !image) return null;
  const env: Record<string, string> = {};
  if (record.createEnv && typeof record.createEnv === "object") {
    for (const [key, entry] of Object.entries(record.createEnv as Record<string, unknown>)) {
      if (typeof entry === "string") env[key] = entry;
    }
  }
  return {
    containerName,
    image,
    workspacePath:
      typeof record.workspacePath === "string" && record.workspacePath
        ? record.workspacePath
        : DEFAULT_WORKSPACE_PATH,
    user: typeof record.user === "string" ? record.user : null,
    memoryLimit: typeof record.memoryLimit === "string" ? record.memoryLimit : null,
    cpuLimit: typeof record.cpuLimit === "string" ? record.cpuLimit : null,
    volumeName: typeof record.volumeName === "string" ? record.volumeName : null,
    dockerContext: typeof record.dockerContext === "string" ? record.dockerContext : null,
    createEnv: env,
  };
}

/**
 * A `CommandManagedRuntimeRunner` backed by `docker exec`.
 *
 * Exposing the container through the same runner interface the SSH and
 * sandbox transports use is what lets every existing caller — GitHub launcher
 * cleanup, command resolution, the bridge — work against a container without
 * knowing Docker exists.
 *
 * It advertises no persistent session and no native sync: `docker exec` starts
 * a fresh process each time, and the workspace lives on the container's own
 * volume rather than being copied in and out.
 */
export function createDockerCommandManagedRuntimeRunner(input: {
  spec: DockerExecutionSpec;
  defaultCwd: string;
}): {
  execute(args: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string;
    timeoutMs?: number;
    onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
  }): Promise<{
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    pid: number | null;
    startedAt: string | null;
  }>;
} {
  return {
    async execute(args) {
      await ensureContainerRunning(input.spec);
      const startedAt = new Date().toISOString();
      const result = await runDockerCli(
        buildExecArgs({
          spec: input.spec,
          command: args.command,
          args: args.args ?? [],
          cwd: args.cwd ?? input.defaultCwd,
          env: args.env ?? {},
          interactive: args.stdin !== undefined,
        }),
        {
          timeoutMs: args.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS,
          ...(args.stdin === undefined ? {} : { stdin: args.stdin }),
          ...(args.onLog ? { onLog: args.onLog } : {}),
          ...(args.onSpawn ? { onSpawn: args.onSpawn } : {}),
        },
      );
      return {
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
        // The pid inside the container is not the host pid, and the host pid
        // is the `docker` CLI's own. Neither is useful to a caller, so report
        // none rather than a misleading number.
        pid: null,
        startedAt,
      };
    },
  };
}
