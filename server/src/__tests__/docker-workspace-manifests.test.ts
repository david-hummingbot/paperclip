import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Drift guard for the image's workspace manifests.
 *
 * The image installs from the committed lockfile, so every workspace member
 * that something else depends on through a `workspace:` specifier must have
 * its package.json inside the build context before `pnpm install` runs. The
 * Dockerfile copies those manifests by hand, one COPY per package, because the
 * install layer must not be invalidated by unrelated source edits.
 *
 * Adding a workspace package and depending on it is therefore two steps, and
 * the second is easy to forget. When it is forgotten the install fails with
 * ERR_PNPM_WORKSPACE_PKG_NOT_FOUND, and it fails only inside Docker: the repo
 * suite, typecheck and a local `pnpm install` all pass, because the package is
 * present everywhere except the build context. That is how
 * `@paperclipai/adapter-openai-compatible` reached master unbuildable.
 *
 * This guard is deliberately cheap: it reads manifests and the Dockerfile as
 * text and runs in the normal suite, so it holds without a Docker build and
 * without CI. It does not prove the image builds. It proves the one invariant
 * that broke.
 *
 * A package no shipped code depends on needs no COPY, so the check is driven
 * by `workspace:` edges rather than by the member list. That is why
 * `@paperclipai/create-paperclip-plugin` is absent from the Dockerfile and
 * must stay allowed.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Glob -> RegExp for the small subset pnpm-workspace.yaml uses. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]+").replace(/\u0000/g, ".*")}$`);
}

/** The `packages:` sequence, split into include and exclude patterns. */
function readWorkspacePatterns(): { include: RegExp[]; exclude: RegExp[] } {
  const source = readFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  const block = /^packages:\n((?:[ \t]*(?:-[^\n]*|#[^\n]*)\n)+)/m.exec(source);
  expect(block, "pnpm-workspace.yaml must declare a packages: sequence").toBeTruthy();
  const entries = block![1]
    .split("\n")
    .map((line) => /^[ \t]*-[ \t]*(.+?)[ \t]*$/.exec(line)?.[1])
    .filter((value): value is string => Boolean(value))
    .map((value) => value.replace(/^["']|["']$/g, ""));
  // If the file's shape ever changes, fail here rather than silently checking
  // nothing: a guard that parses to an empty list would always pass.
  expect(entries.length, "parsed no workspace patterns").toBeGreaterThan(3);
  return {
    include: entries.filter((e) => !e.startsWith("!")).map(globToRegExp),
    exclude: entries.filter((e) => e.startsWith("!")).map((e) => globToRegExp(e.slice(1))),
  };
}

/** Directories holding a package.json, to the depth the workspace globs reach. */
function findPackageDirs(relative: string, depth: number): string[] {
  if (depth < 0) return [];
  const absolute = path.join(repoRoot, relative);
  let entries: string[];
  try {
    entries = readdirSync(absolute);
  } catch {
    return [];
  }
  const found: string[] = [];
  if (relative && entries.includes("package.json")) found.push(relative);
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const child = relative ? `${relative}/${entry}` : entry;
    if (!statSync(path.join(repoRoot, child)).isDirectory()) continue;
    found.push(...findPackageDirs(child, depth - 1));
  }
  return found;
}

function readWorkspaceMembers(): Map<string, string> {
  const { include, exclude } = readWorkspacePatterns();
  const members = new Map<string, string>();
  for (const dir of findPackageDirs("", 4)) {
    if (!include.some((p) => p.test(dir))) continue;
    if (exclude.some((p) => p.test(dir))) continue;
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, dir, "package.json"), "utf8")) as {
      name?: string;
    };
    if (manifest.name) members.set(manifest.name, dir);
  }
  return members;
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

describe("docker workspace manifests", () => {
  const members = readWorkspaceMembers();

  // Guard the guard. A parsing or globbing regression would otherwise leave an
  // empty member map, and every assertion below would pass without checking.
  it("resolves the workspace members it is supposed to check", () => {
    expect(members.size).toBeGreaterThan(20);
    expect(members.get("@paperclipai/server")).toBe("server");
    expect(members.get("@paperclipai/shared")).toBe("packages/shared");
    expect(members.get("@paperclipai/adapter-openai-compatible")).toBe(
      "packages/adapters/openai-compatible",
    );
  });

  it("copies the manifest of every workspace package something depends on", () => {
    const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");

    const required = new Map<string, string[]>();
    for (const [name, dir] of members) {
      const manifest = JSON.parse(readFileSync(path.join(repoRoot, dir, "package.json"), "utf8")) as
        Record<string, Record<string, string> | undefined>;
      for (const field of DEPENDENCY_FIELDS) {
        for (const [dependency, specifier] of Object.entries(manifest[field] ?? {})) {
          if (!specifier.startsWith("workspace:")) continue;
          required.set(dependency, [...(required.get(dependency) ?? []), name]);
        }
      }
    }

    // The edge that broke must be one of the edges this checks.
    expect(required.get("@paperclipai/adapter-openai-compatible")).toContain("@paperclipai/server");

    const missing: string[] = [];
    for (const [dependency, dependents] of required) {
      const dir = members.get(dependency);
      expect(dir, `${dependency} is depended on but is not a workspace member`).toBeTruthy();
      const copied = new RegExp(`^COPY\\b.*\\b${dir!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/package\\.json\\b`, "m")
        .test(dockerfile);
      if (!copied) missing.push(`${dependency} (${dir}/package.json), needed by ${dependents.join(", ")}`);
    }

    expect(
      missing,
      `Dockerfile is missing COPY lines for workspace packages that are depended on.\n` +
        `Add one 'COPY <dir>/package.json <dir>/' line per package beside the others,\n` +
        `or the image build fails with ERR_PNPM_WORKSPACE_PKG_NOT_FOUND:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });
});
