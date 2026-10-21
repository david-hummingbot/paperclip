import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companySecrets, createDb, environments } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const execFileAsync = promisify(execFile);
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();

// The service shells out to ssh-keygen on purpose: it is the authority on the
// format the `ssh` client will read. A host without it cannot run these.
const hasSshKeygen = await execFileAsync("ssh-keygen", ["-?"])
  .then(() => true)
  .catch((err: { code?: unknown; stderr?: unknown }) =>
    // `-?` is not a real flag; ssh-keygen prints usage and exits non-zero. Only
    // a missing binary (ENOENT) means we cannot test.
    err?.code !== "ENOENT",
  );

const describeSshKeys =
  embeddedPostgresSupport.supported && hasSshKeygen ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

describeSshKeys("ssh key service", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let prefixCounter = 0;
  const tempPaths = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ssh-keys-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(environments);
    await db.delete(companySecrets);
    await db.delete(companies);
    for (const target of tempPaths) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    }
    tempPaths.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    prefixCounter += 1;
    const [company] = await db
      .insert(companies)
      .values({ name: `co-${randomUUID()}`, issuePrefix: `S${prefixCounter}` })
      .returning();
    const { sshKeyService } = await import("../services/ssh-keys.js");
    return { svc: sshKeyService(db), companyId: company!.id };
  }

  /** A real key pair made the way an operator would make one. */
  async function makeKeyOnDisk(options?: { passphrase?: string }) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-sshkey-test-"));
    tempPaths.add(dir);
    const keyPath = path.join(dir, "id_ed25519");
    await execFileAsync("ssh-keygen", [
      "-t",
      "ed25519",
      "-N",
      options?.passphrase ?? "",
      "-C",
      "operator@example.com",
      "-f",
      keyPath,
    ]);
    return {
      privateKey: await fs.readFile(keyPath, "utf8"),
      publicKey: (await fs.readFile(`${keyPath}.pub`, "utf8")).trim(),
    };
  }

  it("generates a key and returns only the public half", async () => {
    const { svc, companyId } = await seed();

    const result = await svc.create(companyId, { name: "prod-box" });

    expect(result.source).toBe("generated");
    expect(result.publicKey.startsWith("ssh-ed25519 ")).toBe(true);
    expect(result.fingerprint).toContain("SHA256:");
    expect(result.secretId).toBeTruthy();
    // The private key is never in the response, including right after creating
    // it. The operator installs the public half; the private half stays in the
    // secret store.
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
  });

  it("stores a key an ssh environment resolves and the ssh client can read", async () => {
    const { svc, companyId } = await seed();
    const result = await svc.create(companyId, { name: "prod-box" });

    // Go through the real consumer. The secret store refuses a read by a
    // consumer the secret is not bound to, and environment create is what
    // establishes that binding — so this proves the whole path, not just that
    // a value round-trips.
    const [environment] = await db
      .insert(environments)
      .values({
        companyId,
        name: `ssh-${randomUUID()}`,
        driver: "ssh",
        config: {
          host: "example.invalid",
          port: 22,
          username: "paperclip",
          remoteWorkspacePath: "/srv/paperclip",
          privateKeySecretRef: { type: "secret_ref", secretId: result.secretId, version: "latest" },
        },
      })
      .returning();
    const { secretService } = await import("../services/secrets.js");
    const { collectEnvironmentSecretRefs, resolveEnvironmentDriverConfigForRuntime } =
      await import("../services/environment-config.js");
    await secretService(db).replaceSecretRefsForInstanceTarget(
      { targetType: "environment", targetId: environment!.id },
      await collectEnvironmentSecretRefs({ db, environment: environment! }),
    );

    const resolved = await resolveEnvironmentDriverConfigForRuntime(
      db,
      companyId,
      environment!,
    );
    const stored = (resolved.config as { privateKey: string }).privateKey;

    // Generating with Node's crypto would produce PKCS#8 PEM, which OpenSSH
    // does not accept for ed25519 — it would store cleanly and fail at connect
    // time. Prove the client reads it by deriving the public key back out.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-sshkey-check-"));
    tempPaths.add(dir);
    const keyPath = path.join(dir, "stored");
    await fs.writeFile(keyPath, stored, { mode: 0o600 });
    const { stdout } = await execFileAsync("ssh-keygen", ["-y", "-P", "", "-f", keyPath]);
    expect(stdout.trim()).toBe(result.publicKey);
  });

  it("imports a key the operator already holds, deriving its public half", async () => {
    const { svc, companyId } = await seed();
    const existing = await makeKeyOnDisk();

    const result = await svc.create(companyId, {
      name: "existing-box",
      privateKey: existing.privateKey,
    });

    expect(result.source).toBe("imported");
    // Derived, not asked for: the operator pastes one thing, not two that
    // could disagree.
    expect(result.publicKey).toBe(existing.publicKey);
  });

  it("refuses a passphrase-protected key instead of storing one that cannot connect", async () => {
    const { svc, companyId } = await seed();
    const locked = await makeKeyOnDisk({ passphrase: "hunter2" });

    // Runs connect non-interactively, so nothing can answer the prompt. Storing
    // it would look like success and fail at the first run.
    await expect(
      svc.create(companyId, { name: "locked", privateKey: locked.privateKey }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("refuses text that is not a private key", async () => {
    const { svc, companyId } = await seed();

    await expect(
      svc.create(companyId, { name: "nonsense", privateKey: "not a key at all" }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("refuses a public key pasted where the private key goes", async () => {
    const { svc, companyId } = await seed();
    const existing = await makeKeyOnDisk();

    // An easy mistake, and one that would otherwise store a useless secret.
    await expect(
      svc.create(companyId, { name: "wrong-half", privateKey: existing.publicKey }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("keeps the public key readable without decrypting the private one", async () => {
    const { svc, companyId } = await seed();
    const created = await svc.create(companyId, { name: "prod-box" });

    const found = await svc.getPublicKey(companyId, created.secretId);

    // Showing an operator which key is installed must not require the private
    // half, so this reads the record's metadata.
    expect(found?.publicKey).toBe(created.publicKey);
    expect(found?.source).toBe("generated");
  });

  it("hides another company's key behind a 404-shaped null", async () => {
    const { svc, companyId } = await seed();
    const created = await svc.create(companyId, { name: "prod-box" });
    const { companyId: otherCompanyId } = await seed();

    expect(await svc.getPublicKey(otherCompanyId, created.secretId)).toBeNull();
  });
});
