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

These remain the path for an agent with no provider connection. Folding them
into one precedence order — so a connection wins when one is selected — is
build-list item 3's remaining work, together with teaching
`assertManagedAiProjectAuth` to tell a connection-supplied base URL apart from
an operator override it should reject.

## Not yet implemented

The generic OpenAI-compatible adapter that consumes a connection at run time
(build-list item 4) is not built. Until it lands, a connection is a stored,
validated record that the board and API can manage but no harness reads.
