import type { AdapterRuntimeToolAccess } from "@paperclipai/adapter-utils";
import type { ToolSpec } from "./wire.js";

/**
 * Paperclip's run-scoped control tools, expressed as OpenAI function tools.
 *
 * A CLI-backed adapter receives these through its own harness. This adapter
 * talks to a bare completions endpoint, so it has to describe them itself and
 * execute the calls against the REST endpoints in `runtimeTools`.
 *
 * These are the only tools the adapter exposes. It deliberately does not
 * offer file or shell access: there is no sandbox around a raw completions
 * call, and inventing one here would put arbitrary command execution behind a
 * model with none of the containment the CLI adapters get from their harness.
 */
export const CONNECTIONS_SEARCH_TOOL: ToolSpec = {
  name: "connections_search",
  description:
    "Search the connections and tools available to this agent in Paperclip. Use this before asking for a new connection, to check whether access already exists.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Free-text search over connection and tool names.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export const CONNECTION_REQUEST_TOOL: ToolSpec = {
  name: "connection_request",
  description:
    "Ask the operator to grant this agent a connection it does not have. The request is queued for human approval; it does not grant access by itself.",
  parameters: {
    type: "object",
    properties: {
      connector: {
        type: "string",
        description: "The connector or service being requested.",
      },
      reason: {
        type: "string",
        description: "Why this run needs it.",
      },
    },
    required: ["connector", "reason"],
    additionalProperties: false,
  },
};

export function runtimeToolSpecs(access: AdapterRuntimeToolAccess | undefined): ToolSpec[] {
  if (!access) return [];
  return [CONNECTIONS_SEARCH_TOOL, CONNECTION_REQUEST_TOOL];
}

export interface ToolExecutionResult {
  /** JSON text handed back to the model as the tool result. */
  content: string;
  ok: boolean;
}

/**
 * Executes one model-requested tool call against the Paperclip REST endpoints.
 *
 * Every failure is returned to the model as a tool result rather than thrown.
 * A thrown error would fail the whole run over one bad argument object, when
 * the model can usually recover by correcting the call.
 */
export async function executeToolCall(input: {
  access: AdapterRuntimeToolAccess;
  name: string;
  argumentsJson: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<ToolExecutionResult> {
  const fetchImpl = input.fetchImpl ?? fetch;

  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(input.argumentsJson || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("arguments must be a JSON object");
    }
    args = parsed as Record<string, unknown>;
  } catch (error) {
    return {
      ok: false,
      content: JSON.stringify({
        error: `Could not parse the tool arguments: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
    };
  }

  const endpoint =
    input.name === "connections_search"
      ? input.access.rest.connectionsSearch
      : input.name === "connection_request"
        ? input.access.rest.connectionRequest
        : null;

  if (!endpoint) {
    return {
      ok: false,
      content: JSON.stringify({ error: `Unknown tool "${input.name}".` }),
    };
  }

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.access.bearerToken}`,
      },
      body: JSON.stringify(args),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        content: JSON.stringify({
          error: `The tool call failed with HTTP ${response.status}.`,
          detail: text.slice(0, 2000),
        }),
      };
    }
    // Pass the payload through verbatim when it is already JSON so the model
    // sees the real shape rather than a re-encoded summary.
    return { ok: true, content: text || JSON.stringify({ ok: true }) };
  } catch (error) {
    return {
      ok: false,
      content: JSON.stringify({
        error: `The tool call could not be sent: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
    };
  }
}
