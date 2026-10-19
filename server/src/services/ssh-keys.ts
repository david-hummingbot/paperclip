import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import type { SecretProvider } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { secretService } from "./secrets.js";

const execFileAsync = promisify(execFile);

/**
 * SSH keys for agent computers.
 *
 * An `ssh` agent computer authenticates with a private key resolved from the
 * secret store at run time (`privateKeySecretRef` on the environment config).
 * Getting one there used to mean creating the secret by hand and referencing
 * it; this gives an operator the two ways they actually have a key: generate a
 * fresh one, or paste one they already hold.
 *
 * **`ssh-keygen` is the authority on both paths.** The transport writes the key
 * to a temp file and hands it to the `ssh` CLI with `-i`, so the only format
 * that matters is the one that client reads. Generating with Node's crypto
 * would produce PKCS#8 PEM, which OpenSSH does not accept for ed25519 — the key
 * would store cleanly and then fail at connect time, which is the worst place
 * to find out. Deriving the public key with `ssh-keygen -y` likewise both
 * validates a pasted key and proves the client can read it.
 *
 * The private key is written to the secret store and never returned. The public
 * key is returned, because the operator has to install it on the host.
 */

export interface SshKeyResult {
  secretId: string;
  secretName: string;
  /** Install this on the target host's `authorized_keys`. */
  publicKey: string;
  fingerprint: string;
  /** Whether the private key was generated here or supplied by the operator. */
  source: "generated" | "imported";
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-sshkey-"));
  try {
    return await run(dir);
  } finally {
    // The private key is on disk for the length of one ssh-keygen call. mkdtemp
    // is 0700 and this removes the whole directory, including the `.pub`.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function sshKeygenFailure(err: unknown, fallback: string): never {
  const stderr =
    typeof (err as { stderr?: unknown })?.stderr === "string"
      ? ((err as { stderr: string }).stderr).trim()
      : "";
  throw unprocessable(stderr || fallback, { code: "ssh_key_invalid" });
}

/** Generates an ed25519 keypair and returns both halves. */
async function generateKeyPair(comment: string): Promise<{ privateKey: string; publicKey: string }> {
  return withTempDir(async (dir) => {
    const keyPath = path.join(dir, "id_ed25519");
    try {
      await execFileAsync(
        "ssh-keygen",
        // `-N ""` is an empty passphrase on purpose: the transport runs
        // non-interactively and cannot answer a prompt. The key's protection is
        // the secret store, not a passphrase Paperclip would have to keep
        // beside it.
        ["-t", "ed25519", "-N", "", "-C", comment, "-f", keyPath],
        { timeout: 30_000 },
      );
    } catch (err) {
      sshKeygenFailure(err, "Could not generate an SSH key on this host.");
    }
    const [privateKey, publicKey] = await Promise.all([
      fs.readFile(keyPath, "utf8"),
      fs.readFile(`${keyPath}.pub`, "utf8"),
    ]);
    return { privateKey, publicKey: publicKey.trim() };
  });
}

/**
 * Derives the public key from a pasted private key.
 *
 * This is the validation too: `ssh-keygen -y` fails on anything the `ssh`
 * client could not use, including a passphrase-protected key — which the
 * transport cannot unlock, so accepting one would store a key that can never
 * connect.
 */
async function derivePublicKey(privateKey: string): Promise<string> {
  return withTempDir(async (dir) => {
    const keyPath = path.join(dir, "id_imported");
    await fs.writeFile(keyPath, privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`, {
      mode: 0o600,
    });
    try {
      const { stdout } = await execFileAsync("ssh-keygen", ["-y", "-P", "", "-f", keyPath], {
        timeout: 30_000,
      });
      return stdout.trim();
    } catch (err) {
      sshKeygenFailure(
        err,
        "That is not a usable SSH private key. A passphrase-protected key cannot be used, because runs connect non-interactively.",
      );
    }
  });
}

async function fingerprint(publicKey: string): Promise<string> {
  return withTempDir(async (dir) => {
    const pubPath = path.join(dir, "key.pub");
    await fs.writeFile(pubPath, `${publicKey}\n`, "utf8");
    const { stdout } = await execFileAsync("ssh-keygen", ["-l", "-f", pubPath], {
      timeout: 30_000,
    });
    return stdout.trim();
  });
}

export function sshKeyService(db: Db) {
  const secrets = secretService(db);

  return {
    /**
     * Puts an SSH private key in the secret store and returns the public half.
     *
     * The returned `secretId` is what an `ssh` environment's
     * `privateKeySecretRef` points at.
     */
    create: async (
      companyId: string,
      input: {
        name: string;
        /** Omit to generate a fresh ed25519 key. */
        privateKey?: string | null;
        comment?: string | null;
        provider?: SecretProvider;
        providerConfigId?: string | null;
      },
      actor?: { userId?: string | null; agentId?: string | null },
    ): Promise<SshKeyResult> => {
      const supplied = input.privateKey?.trim();
      const comment = input.comment?.trim() || `paperclip-${input.name}`;
      const { privateKey, publicKey, source } = supplied
        ? {
            privateKey: supplied,
            publicKey: await derivePublicKey(supplied),
            source: "imported" as const,
          }
        : { ...(await generateKeyPair(comment)), source: "generated" as const };

      const secret = await secrets.create(
        companyId,
        {
          name: input.name,
          provider: input.provider ?? "local_encrypted",
          providerConfigId: input.providerConfigId ?? null,
          value: privateKey,
          description: `SSH private key (${source}). Public key: ${publicKey}`,
          // The public half is not a secret and the operator needs it after the
          // fact — to install it on a second host, or to check what is
          // authorized — so keep it on the record rather than only in this
          // response.
          providerMetadata: { sshPublicKey: publicKey, sshKeySource: source },
        },
        actor,
      );

      return {
        secretId: secret.id,
        secretName: secret.name,
        publicKey,
        fingerprint: await fingerprint(publicKey),
        source,
      };
    },

    /**
     * The public half of a stored SSH key, from the secret record.
     *
     * Reads the metadata rather than the secret value: showing an operator
     * which key is installed must not require decrypting the private key.
     */
    getPublicKey: async (
      companyId: string,
      secretId: string,
    ): Promise<{ publicKey: string; source: string | null } | null> => {
      const secret = await secrets.getById(secretId);
      if (!secret || secret.companyId !== companyId) return null;
      const metadata =
        secret.providerMetadata && typeof secret.providerMetadata === "object"
          ? (secret.providerMetadata as Record<string, unknown>)
          : {};
      const publicKey = typeof metadata.sshPublicKey === "string" ? metadata.sshPublicKey : null;
      if (!publicKey) return null;
      return {
        publicKey,
        source: typeof metadata.sshKeySource === "string" ? metadata.sshKeySource : null,
      };
    },
  };
}

export type SshKeyService = ReturnType<typeof sshKeyService>;

/** Exported for tests: a unique secret name for a generated agent key. */
export function defaultSshKeyName(agentName: string): string {
  return `ssh-key-${agentName}-${randomUUID().slice(0, 8)}`;
}
