# Agent computers

An agent's **computer** is the machine its runs execute on. It is independent
of which model the agent talks to: placement and provider connection are two
separate choices.

| Placement | Meaning | Mechanism |
| --- | --- | --- |
| `shared` | No dedicated machine. Runs use the project cwd on the Paperclip host. | Today's `local` environment plus the project workspace strategy. This is the default, so every existing agent is unchanged. |
| `docker` | One long-lived container that belongs to this agent. | First-class `docker` environment driver. |
| `ssh` | One existing host — a VPS or a full virtual machine. | The existing SSH environment config, shown as this agent's computer. |

**Local isolation is Docker; a full VM is an SSH target.** Paperclip does not
boot a hypervisor.

A git worktree is a *checkout*, not a computer. It lives on whichever machine
the placement names — including a coordination room's per-member worktree,
which never allocates a second machine.

## Why Docker is a driver and not a sandbox plugin

The cloud sandbox plugins (e2b, Daytona, Modal, Kubernetes, …) model a
**short lease**: the provider hands out an environment, the run uses it, the
provider reclaims it. An agent's container is the opposite — created on first
use and reused across heartbeats, so its home directory, tool installs and
worktrees survive between runs. Putting that lifetime inside a lease model
would fight it at every step.

Cloud sandboxes stay available and unchanged. They are not a substitute for a
container on your own host, and a container is not a substitute for them.

## The container

One container per agent, created on first use:

```
docker run --detach --name paperclip-agent-<agentId> \
  --label ai.paperclip.owner=agent \
  --workdir /workspace \
  [--user U] [--memory M] [--cpus C] \
  --volume paperclip-agent-<agentId>-home:/workspace \
  <image> sleep infinity
```

- **`sleep infinity`** holds it open. The adapter arrives through `docker exec`,
  so a container whose entrypoint exits would lose the agent its machine
  between heartbeats.
- **Names are derived from the agent id**, not typed by an operator, so they
  survive a rename and cannot collide between agents.
- **The named volume** is what makes the machine persistent. Work left in
  `/workspace` is there on the next run.
- **The `docker` CLI is used rather than the daemon socket**, so the driver
  inherits whatever the operator has already configured — remote contexts,
  rootless daemons, Colima, Docker Desktop — with no second source of
  connection settings to keep in sync. `dockerContext` selects a non-default
  daemon.

`ensureContainerRunning` is idempotent and runs before every run: a healthy
container short-circuits after one `inspect`, and a stopped or paused one is
**restarted rather than replaced**, so the work inside it is preserved.

## Lifecycle

| Action | Effect |
| --- | --- |
| Start | Creates the container if missing, restarts it if stopped. |
| Pause | `docker stop`. The container and its volume are kept. |
| Terminate | `docker rm --force`. **The volume is kept** unless `removeVolume` is set. |

Terminating does not remove the volume by default, because reclaiming a
container must not silently destroy uncommitted work. Removing the volume is an
explicit choice.

Changing placement back to `shared` deletes the environment row but **leaves
the container alone** — a placement change may be temporary, and it is not the
same request as "destroy this machine".

## Ownership

The environment row carries `companyId` and `agentId`. Another company cannot
select the same host, image or key, and an SSH host that is one agent's
computer cannot also be another's — that is refused with a 409.

This is why `environments` gained those columns and why
`environments_name_idx` is now unique per owner rather than instance-wide: two
companies with an agent of the same name would otherwise collide.

`environments_local_driver_idx` is deliberately untouched. The `local`
environment is one instance-level row shared by every company, and the
heartbeat upserts it with `ON CONFLICT ("driver") WHERE driver = 'local'`,
which only matches an index with exactly that predicate. A per-agent computer
is a `docker` or `ssh` row, never `local`.

## SSH keys

An `ssh` computer authenticates with a private key resolved from the secret
store at run time, named by `privateKeySecretRef` on the environment config.
Two endpoints cover the two ways an operator has a key:

| Method | Path | |
| --- | --- | --- |
| `POST` | `/api/companies/:companyId/ssh-keys` | Omit `privateKey` to generate a fresh ed25519 key; supply one to import a key you already hold. |
| `GET` | `/api/companies/:companyId/ssh-keys/:secretId/public-key` | The public half, read from the secret's metadata. |

The response carries the public key, its fingerprint, and the `secretId` to put
in `privateKeySecretRef`. **The private key is never returned**, including in
the response that creates it.

`ssh-keygen` does both jobs, and that is deliberate. The transport writes the
key to a temp file and hands it to the `ssh` CLI with `-i`, so the only format
that matters is the one that client reads — generating with Node's crypto would
produce PKCS#8 PEM, which OpenSSH does not accept for ed25519, and the key would
store cleanly and then fail at connect time. On the import path `ssh-keygen -y`
derives the public half, which is also the validation: it rejects anything the
client could not use.

A **passphrase-protected key is refused**. Runs connect non-interactively and
nothing can answer the prompt, so accepting one would look like success and fail
at the first run. A generated key has no passphrase for the same reason; its
protection is the secret store.

Creating the key does not install it. Two steps remain, and both are the
existing paths:

1. Put the public key in the target host's `authorized_keys`.
2. Reference the secret from the environment's `privateKeySecretRef`.
   Environment create and update bind the secret to that environment; the
   secret store refuses a read by a consumer the secret is not bound to, so a
   key that is stored but unreferenced cannot be resolved by a run.

## API

| Method | Path |
| --- | --- |
| `GET` | `/api/companies/:companyId/agents/:agentId/computer` |
| `PUT` | `/api/companies/:companyId/agents/:agentId/computer` |
| `POST` | `/api/companies/:companyId/agents/:agentId/computer/start` |
| `POST` | `/api/companies/:companyId/agents/:agentId/computer/pause` |
| `POST` | `/api/companies/:companyId/agents/:agentId/computer/terminate` |

`GET` reports the live container state. It does **not** fail when the Docker
CLI is missing or the daemon is down — reading an agent's settings must not
depend on a working daemon, so the state comes back as `missing` and the
failure is logged.

## Reaching a local model from a container

`localhost` inside a container is the container, not the host. An agent on a
`docker` computer that uses a local model server needs
`http://host.docker.internal:1234/v1` in its provider connection, not
`http://localhost:1234/v1`. See `doc/provider-connections.md`.

## Not yet implemented

- **Workspace staging.** The container's workspace lives on its own volume and
  persists between runs; nothing copies a host directory in or out, and
  referenced projects are not staged. The same is true of the SSH transport.
- **The native runner path.** It requires a provider-supplied command runner,
  which a container does not have, so a docker target falls to the existing
  `runner_transport_ineligible` guard rather than running somewhere unexpected.
- **Image build or pull orchestration.** The image must already be resolvable
  by the daemon.
- **No UI.** Placement is managed through the API only.
