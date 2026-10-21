import type { AdapterModel } from "@paperclipai/adapter-utils";

export const ADAPTER_TYPE = "openai_compatible";

/**
 * No static catalog: the models this adapter can reach are whatever the
 * selected provider connection serves. The UI reads the connection's own
 * `models` list, or discovers them from `GET {baseUrl}/models`.
 */
export const models: AdapterModel[] = [];

export const agentConfigurationDoc = `
# openai_compatible

Talks to any OpenAI-compatible endpoint through a Paperclip **provider connection**.
One adapter covers OpenAI, OpenRouter, Venice, a private gateway, and a local
model server such as LM Studio, Ollama or vLLM — they differ by connection, not
by adapter.

## Configuration

- \`model\` (string, required): the model id as the endpoint names it, for
  example \`gpt-4o\` or \`qwen3-coder-30b\`. There is no fixed catalog; the ids
  come from the connection.
- \`systemPrompt\` (string, optional): replaces the default system prompt.
- \`maxToolRounds\` (number, optional, default 8): how many assistant→tool→
  assistant cycles one run may take before it stops. Guards against a model
  that keeps calling tools without concluding.
- \`requestTimeoutMs\` (number, optional, default 300000): per-request timeout.

The endpoint, wire format, API key and extra headers come from the provider
connection selected on the agent, not from this config. Nothing here holds a
credential.

## Tools

The model is offered Paperclip's run-scoped control tools —
\`connections_search\` and \`connection_request\` — and nothing else.

It has **no file system or shell access**. A raw completions call has none of
the containment a CLI harness provides, so this adapter does not invent it. For
work that edits a repository, use a CLI-backed adapter such as
\`claude_local\`, \`codex_local\` or \`opencode_local\`.

## Sessions

The conversation transcript is the session. Paperclip keys it by task, so the
same agent keeps separate threads for separate work without any configuration.
`.trim();
