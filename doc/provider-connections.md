# Provider connections

A provider connection is a company-scoped endpoint an agent talks to: a wire
format, a base URL, and an optional API key held in the company secret store.

It exists because upstream Paperclip pins four providers (`anthropic`,
`openai`, `openrouter`, `xai`) into a TypeScript union *and* a database CHECK
constraint, each wired to one harness and one env var. Anything else — a
private gateway, Venice, a model server on your own machine — had to go through
one of two undocumented per-harness env hatches. A connection is a row, so
adding a vendor adds a row rather than a branch in compatibility code.

## What a connection holds

| Field | Meaning |
| --- | --- |
| `name` | Display name. Unique per company, not instance-wide. |
| `preset` | Which preset it came from, or `custom`. |
| `wire` | `openai_chat`, `openai_responses`, `anthropic`, or `acp`. |
| `baseUrl` | API root, for example `https://api.openai.com/v1`. |
| `apiKeySecretRef` | A reference into the company secret store, or null. |
| `headers` | Extra non-auth headers, merged over the preset's defaults. |
| `models` | Static model ids for endpoints without usable discovery. |

The API never returns the key or its reference — only `hasApiKey`.

## Presets

`GET /api/provider-presets` returns the catalog. It is instance-level reference
data (base URLs and wire formats, no company or user content).

| Preset | Base URL | Key |
| --- | --- | --- |
| `openai` | `https://api.openai.com/v1` | required |
| `anthropic` | `https://api.anthropic.com/v1` | required |
| `openrouter` | `https://openrouter.ai/api/v1` | required |
| `venice` | `https://api.venice.ai/api/v1` | required |
| `xai` | `https://api.x.ai/v1` | required |
| `local_openai` | `http://localhost:1234/v1` | none |
| `custom` | yours | your call |

## Local model servers

`local_openai` covers LM Studio, Ollama and vLLM: all three expose an
OpenAI-compatible `/v1`, so they are the same record with a different port.

```
LM Studio  http://localhost:1234/v1
Ollama     http://localhost:11434/v1
vLLM       http://localhost:8000/v1
```

**`localhost` resolves on the agent's computer, not on the Paperclip host.**
This matters as soon as an agent has a dedicated computer:

| Agent compute placement | Host to use |
| --- | --- |
| `shared` | `localhost` — the Paperclip host is the agent's machine |
| `docker` | `host.docker.internal` to reach the host from the container |
| `ssh` | an address reachable from that host, or an SSH tunnel |

## Base URL validation

Validation is **strict about shape and permissive about destination**.

Rejected: a non-HTTP scheme, a relative URL, embedded credentials (they belong
in the secret store), and any query string or fragment (an API root takes
neither, and both are places a key leaks into logs).

Accepted: loopback, RFC 1918 addresses, `host.docker.internal`, and any other
private destination. The SSRF guard `guardedRemoteHttpFetch` applies to the
announcement feed is right for a URL the instance discovered and wrong for one
an operator typed — applying it here would block every local model.

A trailing slash is stripped on write, because `new URL("chat/completions",
base)` silently drops the last path segment when the base ends in `/`.

`Authorization`, `x-api-key` and `proxy-authorization` are refused as custom
headers. Auth is derived from `apiKeySecretRef`, so a key cannot be pasted into
free-text config where it would be stored unencrypted and echoed back on read.

A keyless endpoint is accepted on loopback and refused on a remote host, where
it is nearly always a mistake rather than an intent to send unauthenticated
requests to a third party.

## One connection per agent

An agent selects one connection, on `agents.providerConnectionId`. A connection
is *the* provider the agent uses, not a pool it picks from per task. Fallback
chains and cost-based routing are a separate feature with their own failure
semantics and are deliberately out of scope.

Deleting a connection does not delete its agents. The composite foreign key
carries no ON DELETE action — `SET NULL` on a composite key would also null
`agents.company_id`, which is NOT NULL — so the service detaches bound agents
in the same transaction and the delete response reports which ones lost their
provider.

## API

All routes are company-scoped and enforce company access.

| Method | Path |
| --- | --- |
| `GET` | `/api/provider-presets` |
| `GET` | `/api/companies/:companyId/provider-connections` |
| `GET` | `/api/companies/:companyId/provider-connections/:id` |
| `POST` | `/api/companies/:companyId/provider-connections` |
| `PATCH` | `/api/companies/:companyId/provider-connections/:id` |
| `DELETE` | `/api/companies/:companyId/provider-connections/:id` |

Create, update and delete write activity-log entries. A connection id from
another company returns 404, not 403, like every other cross-tenant lookup.

## Relationship to the existing env hatches

Two per-harness env hatches already point a harness at an arbitrary
OpenAI-compatible endpoint, and both still work:

- `PAPERCLIP_OPENCODE_PROVIDERS` — a JSON map in OpenCode's `provider` shape.
- `PAPERCLIP_CODEX_PROVIDERS` — JSON mapping onto Codex `[model_providers.<id>]`.

`stripAiAuthBindings` also preserves `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`
and `XAI_BASE_URL` in the agent environment.

### One precedence order

Three mechanisms can point a harness at an endpoint. They are ranked, and the
ranking is enforced rather than conventional:

1. **A managed AI connection owns the run env.** An agent's config env carrying
   any routing variable is refused with `ai_connection_incompatible` at dispatch
   — a 422 that names the conflict — and every routing variable is then blanked
   in the child environment. A managed subscription is never layered with
   another endpoint.
2. **A provider connection beats the agent's own hatches.** Paperclip fills the
   same variables from the selected connection and its values win, because the
   connection is the authority on where the model lives. A managed binding
   causes provider-connection resolution to be skipped entirely, so (1) and (2)
   never both apply.
3. **The agent's own env hatches apply when neither of the above does.** This is
   the unchanged path for an agent with no connection of either kind.

The routing variables are `PAPERCLIP_OPENCODE_PROVIDERS`,
`PAPERCLIP_CODEX_PROVIDERS`, `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` and
`XAI_BASE_URL`. A hired agent carrying any of them keeps its own routing instead
of inheriting its manager's connection, since naming an endpoint is itself an
auth override.

`PAPERCLIP_CODEX_PROVIDERS` was previously absent from every one of those lists
while its OpenCode twin was present in all of them. That was a hole, not a
style difference: the variable is read by `prepareCodexRuntimeConfig` and
written into `config.toml` as `model_provider`, `base_url` and `env_key` — the
exact keys `assertManagedAiProjectAuth` scans *project files* for — so the env
hatch bypassed the check the file scan enforces, and a managed connection could
be silently repointed. Tests assert against the real key lists so the lists
cannot drift apart again.

`assertManagedAiProjectAuth` needs no change for connection-supplied base URLs:
it only runs under a managed binding, and a managed binding skips provider
connections outright, so the two can never be present together.

## Driving a CLI harness with a connection

An agent with a provider connection and an adapter type of `opencode_local`,
`codex_local` or `claude_local` gets that connection injected into the harness
at dispatch. This is what makes a local or gateway model an *ordinary* agent:
the harness, its tools, skills, workspace and permissions are unchanged, and
only the endpoint serving the tokens differs.

| Adapter | Needs wire | Injected |
| --- | --- | --- |
| `opencode_local` | `openai_chat`, `openai_responses` | `PAPERCLIP_OPENCODE_PROVIDERS`, `PAPERCLIP_OPENCODE_SMALL_MODEL`, and a rewritten `model` |
| `codex_local` | `openai_chat`, `openai_responses` | `PAPERCLIP_CODEX_PROVIDERS` |
| `claude_local` | `anthropic` | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` |

The provider is always registered under the fixed id `paperclip`. A connection
name is operator-editable and may contain characters neither harness accepts in
a provider key, and nothing else in the generated config refers to it.

Three details are not obvious and each one is a run that would otherwise fail:

- **OpenCode needs an explicit `models` map.** `OPENCODE_ALLOW_ALL_MODELS` does
  not bypass its internal `getModel()`, so an id the endpoint serves is still
  rejected with "Model not found" unless it is listed. The agent's `model` is
  also rewritten to `paperclip/<model>`, since OpenCode resolves a model ref
  only within a named provider. It splits on the *first* slash, so a
  vendor-qualified id such as `qwen/qwen3-coder` survives intact.
- **OpenCode's auxiliary small model is pinned.** Its default is a built-in
  provider model a repointed endpoint will not serve, and that failure — from a
  session-title call, not the agent's work — aborts the whole run.
- **Codex's `--model` picks a model within the selected provider**, so the
  provider is chosen with `model_provider` and the agent's `model` is left
  alone.

`openai_compatible` is absent from that table on purpose: it reads the
connection off the runtime config itself, so there is nothing to inject and
nothing to report.

When the adapter and the connection's wire disagree — a `claude_local` agent
pointed at an OpenAI endpoint — nothing is injected. The agent runs on its
normal credentials and the reason is written to the run log as a `lifecycle`
warning, rather than the request being mis-sent or the run failing to start. An
agent on a managed AI binding is skipped the same way: a managed subscription
is not layered with a connection.

### Where the key goes

The generated JSON never carries the key; it names the env var
`PAPERCLIP_PROVIDER_API_KEY`, which is set separately. What each harness does
after that differs:

- **Codex** keeps the name. `config.toml` stores `env_key` and Codex reads the
  variable at call time, so the key is never written to disk.
- **OpenCode** resolves the `{env:...}` placeholder server-side and writes the
  value into its managed `opencode.json`. This is deliberate and predates this
  feature: the run process may be sandboxed and is not guaranteed to carry the
  variable to OpenCode's spawned server. That file is in a per-run `mkdtemp`
  directory (mode 0700) that `cleanup()` removes when the run ends — the same
  treatment OpenCode's other managed credentials already get.

A keyless local endpoint gets no key variable and no `apiKey` field at all,
rather than an empty string, which some servers reject.

## The `openai_compatible` adapter

An agent set to adapter type `openai_compatible` runs against its selected
connection. This is the harness that makes a connection do something; the other
adapters spawn a CLI that brings its own credentials.

It speaks both OpenAI wire formats — `openai_chat` posts to
`{baseUrl}/chat/completions`, `openai_responses` to `{baseUrl}/responses` — and
picks by the connection's `wire` field. An `anthropic` or `acp` connection is
refused with `provider_wire_unsupported` rather than silently mis-sent.

Agent config keys:

| Key | Meaning |
| --- | --- |
| `model` | Required. The model id as the endpoint names it. No fixed catalog. |
| `systemPrompt` | Optional. Replaces the default system prompt. |
| `maxToolRounds` | Optional, default 8. Assistant→tool→assistant cycles per run. |
| `requestTimeoutMs` | Optional, default 300000. |

The endpoint, wire, key and headers come from the connection, never from agent
config, so no agent config holds a credential. The server resolves
`apiKeySecretRef` and injects the value just before dispatch; it lives on the
in-memory run config only and is never written back to the agent.

### Tools, and what this adapter cannot do

The model is offered Paperclip's run-scoped control tools —
`connections_search` and `connection_request` — and nothing else.

**There is no file system or shell access.** A raw completions call has none of
the containment a CLI harness provides, so the adapter does not invent it. This
adapter suits roles whose output is text and judgement: review, triage,
research, planning.

It is **not** how you run a local model as an ordinary agent. A local model is
a cost choice, not a reduced role — it is expected to edit files and run
commands like any other agent. That comes from pointing a CLI harness
(`opencode_local`, `codex_local`) at the connection, which keeps the agent's
tools, skills, workspace and permissions exactly as they are and changes only
which endpoint serves the tokens. See "Driving a CLI harness with a connection"
above.

A model that keeps calling tools without concluding stops at `maxToolRounds`
with a `tool_round_limit` error, rather than looping until the budget is gone.

### Sessions

The conversation transcript *is* the session — a completions endpoint is
stateless, so there is nothing else to resume. Paperclip stores it in
`sessionParams` keyed by task, which is what keeps an agent's room thread
separate from its review thread with no adapter-side awareness of either.

A transport or provider failure mid-conversation still returns the transcript,
so turns that already succeeded are not discarded by a later error.

### Error families

| Situation | Family | Effect |
| --- | --- | --- |
| 429, or an insufficient-quota body | `provider_quota` | Pause and retry, honouring `Retry-After` |
| 5xx, 408, 409, timeout, connection refused | `transient_upstream` | Retry |
| `content_filter` / refusal finish reason | `model_refusal` | Terminal; no retry into the same refusal |
| 401/403, 404, other 4xx | none | Terminal |

A connection-refused error names the local-server case explicitly, and a 404
says to check the base URL's version segment — those two account for most
first-run failures.

## Not yet implemented

- Model discovery from `GET {baseUrl}/models` is used by the connection probe
  but not yet surfaced as a picker in the board.
- No UI: connections are managed through the API only.
