import { describe, expect, it } from "vitest";
import {
  buildExecArgs,
  containerNameForAgent,
  parseDockerExecutionSpec,
  volumeNameForAgent,
  type DockerExecutionSpec,
} from "./docker.js";

const SPEC: DockerExecutionSpec = {
  containerName: "paperclip-agent-abc",
  image: "paperclip-local:latest",
  workspacePath: "/workspace",
  user: "node",
  memoryLimit: "4g",
  cpuLimit: "2",
  volumeName: "paperclip-agent-abc-home",
  dockerContext: null,
  createEnv: {},
};

describe("container naming", () => {
  it("derives a Docker-legal name from the agent id", () => {
    const name = containerNameForAgent("7F3A-9b2c_d.e");
    expect(name).toBe("paperclip-agent-7f3a-9b2c_d.e");
    // Docker's own character class for names.
    expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
  });

  it("strips characters Docker would reject", () => {
    expect(containerNameForAgent("a b/c:d")).toBe("paperclip-agent-abcd");
  });

  it("keys the volume to the same agent so work survives re-creation", () => {
    expect(volumeNameForAgent("abc")).toBe(`${containerNameForAgent("abc")}-home`);
  });

  it("is stable for one agent, so a rename never orphans its container", () => {
    expect(containerNameForAgent("abc")).toBe(containerNameForAgent("abc"));
  });
});

describe("buildExecArgs", () => {
  it("execs into the container with the run's cwd and env", () => {
    const args = buildExecArgs({
      spec: SPEC,
      command: "claude",
      args: ["--print"],
      cwd: "/workspace/repo",
      env: { PAPERCLIP_RUN_ID: "run-1" },
    });
    expect(args).toEqual([
      "exec",
      "--user",
      "node",
      "--workdir",
      "/workspace/repo",
      "--env",
      "PAPERCLIP_RUN_ID=run-1",
      "paperclip-agent-abc",
      "claude",
      "--print",
    ]);
  });

  it("falls back to the container workspace when the run names no cwd", () => {
    const args = buildExecArgs({ spec: SPEC, command: "sh", args: [] });
    expect(args[args.indexOf("--workdir") + 1]).toBe("/workspace");
  });

  it("asks for an interactive exec only when stdin is being written", () => {
    expect(buildExecArgs({ spec: SPEC, command: "sh", args: [] })).not.toContain("--interactive");
    expect(
      buildExecArgs({ spec: SPEC, command: "sh", args: [], interactive: true }),
    ).toContain("--interactive");
  });

  it("passes the docker context through so a non-default daemon is honoured", () => {
    const args = buildExecArgs({
      spec: { ...SPEC, dockerContext: "colima" },
      command: "sh",
      args: [],
    });
    expect(args.slice(0, 3)).toEqual(["--context", "colima", "exec"]);
  });

  it("does not send a --user flag when the image's default user is wanted", () => {
    const args = buildExecArgs({ spec: { ...SPEC, user: null }, command: "sh", args: [] });
    expect(args).not.toContain("--user");
  });
});

describe("parseDockerExecutionSpec", () => {
  it("requires a container name and an image", () => {
    expect(parseDockerExecutionSpec({ image: "x" })).toBeNull();
    expect(parseDockerExecutionSpec({ containerName: "x" })).toBeNull();
    expect(parseDockerExecutionSpec(null)).toBeNull();
    expect(parseDockerExecutionSpec("not an object")).toBeNull();
  });

  it("defaults the workspace path rather than leaving it empty", () => {
    const parsed = parseDockerExecutionSpec({ containerName: "c", image: "i" });
    expect(parsed?.workspacePath).toBe("/workspace");
  });

  it("drops non-string env values instead of passing them to the CLI", () => {
    const parsed = parseDockerExecutionSpec({
      containerName: "c",
      image: "i",
      createEnv: { GOOD: "1", BAD: 2, ALSO_BAD: null },
    });
    expect(parsed?.createEnv).toEqual({ GOOD: "1" });
  });
});
