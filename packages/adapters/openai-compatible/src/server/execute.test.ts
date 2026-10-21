import { describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";
import { classifyProviderError, classifyTransportError } from "./errors.js";

const CONNECTION = {
  id: "conn-1",
  name: "LM Studio",
  wire: "openai_chat",
  baseUrl: "http://localhost:1234/v1",
  apiKey: null,
  headers: {},
};

function chatResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function makeCtx(
  overrides: {
    config?: Record<string, unknown>;
    fetchImpl?: typeof fetch;
    sessionParams?: Record<string, unknown> | null;
    runtimeTools?: AdapterExecutionContext["runtimeTools"];
    signal?: AbortSignal;
  } = {},
): AdapterExecutionContext {
  const logs: string[] = [];
  return {
    runId: "run-1",
    agent: { id: "a1", companyId: "c1", name: "agent", adapterType: "openai_compatible", adapterConfig: {} },
    runtime: {
      sessionId: null,
      sessionParams: overrides.sessionParams ?? null,
      sessionDisplayId: null,
      taskKey: "issue-1",
    },
    config: {
      model: "qwen3-coder-30b",
      paperclipProviderConnection: CONNECTION,
      paperclipFetchImpl: overrides.fetchImpl,
      ...overrides.config,
    },
    context: { paperclipWake: { reason: "issue_assigned" } },
    onLog: async (_stream: "stdout" | "stderr", chunk: string) => {
      logs.push(chunk);
    },
    ...(overrides.runtimeTools ? { runtimeTools: overrides.runtimeTools } : {}),
    ...(overrides.signal ? { signal: overrides.signal } : {}),
  } as unknown as AdapterExecutionContext;
}

const RUNTIME_TOOLS = {
  version: 1,
  guidance: "",
  mcpEndpoint: "http://paperclip.test/mcp",
  rest: {
    connectionsSearch: "http://paperclip.test/api/connections/search",
    connectionRequest: "http://paperclip.test/api/connections/request",
  },
  bearerToken: "run-token",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  tools: ["connections_search", "connection_request"],
} as unknown as AdapterExecutionContext["runtimeTools"];

describe("openai_compatible execute", () => {
  it("refuses to run without a provider connection", async () => {
    const result = await execute(makeCtx({ config: { paperclipProviderConnection: undefined } }));
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("provider_connection_missing");
  });

  it("refuses a wire format it does not speak", async () => {
    const result = await execute(
      makeCtx({ config: { paperclipProviderConnection: { ...CONNECTION, wire: "anthropic" } } }),
    );
    expect(result.errorCode).toBe("provider_wire_unsupported");
  });

  it("completes a single turn and persists the transcript as the session", async () => {
    const fetchImpl = vi.fn(async () =>
      chatResponse({
        model: "qwen3-coder-30b",
        choices: [{ finish_reason: "stop", message: { content: "done" } }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      }),
    ) as unknown as typeof fetch;

    const result = await execute(makeCtx({ fetchImpl }));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("done");
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 4 });
    // Per-run, not cumulative: the host must not delta these against the
    // previous run on the same session.
    expect(result.usageBasis).toBe("per_run");
    const messages = (result.sessionParams as { messages: unknown[] }).messages;
    expect(messages).toHaveLength(3); // system, user, assistant
  });

  it("sends no Authorization header for a keyless local endpoint", async () => {
    const fetchImpl = vi.fn(async () =>
      chatResponse({ choices: [{ message: { content: "ok" } }] }),
    ) as unknown as typeof fetch;

    await execute(makeCtx({ fetchImpl }));

    const init = vi.mocked(fetchImpl).mock.calls[0]![1] as RequestInit;
    expect(Object.keys(init.headers as Record<string, string>)).not.toContain("authorization");
  });

  it("replays a stored transcript instead of restarting the conversation", async () => {
    const fetchImpl = vi.fn(async () =>
      chatResponse({ choices: [{ message: { content: "second" } }] }),
    ) as unknown as typeof fetch;

    await execute(
      makeCtx({
        fetchImpl,
        sessionParams: {
          messages: [
            { role: "system", content: "sys" },
            { role: "user", content: "first" },
            { role: "assistant", content: "first answer" },
          ],
        },
      }),
    );

    const body = JSON.parse((vi.mocked(fetchImpl).mock.calls[0]![1] as RequestInit).body as string);
    // Prior turns are replayed, and the new turn is appended rather than a
    // second system prompt being inserted.
    expect(body.messages).toHaveLength(4);
    expect(body.messages.filter((m: { role: string }) => m.role === "system")).toHaveLength(1);
  });

  it("runs a tool call and feeds the result back to the model", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        chatResponse({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: "",
                tool_calls: [
                  { id: "c1", function: { name: "connections_search", arguments: '{"query":"slack"}' } },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response('{"results":[]}', { status: 200 }))
      .mockResolvedValueOnce(
        chatResponse({ choices: [{ finish_reason: "stop", message: { content: "no slack" } }] }),
      ) as unknown as typeof fetch;

    const result = await execute(makeCtx({ fetchImpl, runtimeTools: RUNTIME_TOOLS }));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("no slack");
    // completion → tool → completion
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(fetchImpl).mock.calls[1]![0]).toBe(
      "http://paperclip.test/api/connections/search",
    );
    const messages = (result.sessionParams as { messages: { role: string }[] }).messages;
    expect(messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  it("stops rather than looping when the model keeps calling tools", async () => {
    const toolTurn = () =>
      chatResponse({
        choices: [
          {
            message: {
              content: "",
              tool_calls: [{ id: "c", function: { name: "connections_search", arguments: "{}" } }],
            },
          },
        ],
      });
    const fetchImpl = vi.fn(async (url: unknown) =>
      String(url).includes("/connections/") ? new Response("{}", { status: 200 }) : toolTurn(),
    ) as unknown as typeof fetch;

    const result = await execute(
      makeCtx({ fetchImpl, runtimeTools: RUNTIME_TOOLS, config: { maxToolRounds: 2 } }),
    );

    // A model that never concludes would otherwise burn the budget silently.
    expect(result.errorCode).toBe("tool_round_limit");
    expect(result.exitCode).toBe(1);
  });

  it("returns a malformed tool argument to the model instead of failing the run", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        chatResponse({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [{ id: "c1", function: { name: "connections_search", arguments: "not json" } }],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        chatResponse({ choices: [{ message: { content: "recovered" } }] }),
      ) as unknown as typeof fetch;

    const result = await execute(makeCtx({ fetchImpl, runtimeTools: RUNTIME_TOOLS }));

    expect(result.exitCode).toBe(0);
    const messages = (result.sessionParams as { messages: { role: string; content: string }[] })
      .messages;
    const toolResult = messages.find((m) => m.role === "tool")!;
    expect(toolResult.content).toContain("Could not parse the tool arguments");
    // The endpoint was never called with bad arguments.
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(2);
  });

  it("keeps the partial transcript when the provider fails mid-conversation", async () => {
    const fetchImpl = vi.fn(async () =>
      chatResponse({ error: { message: "upstream exploded" } }, { status: 503 }),
    ) as unknown as typeof fetch;

    const result = await execute(makeCtx({ fetchImpl }));

    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.errorMessage).toContain("upstream exploded");
    // Turns that already happened must not be discarded by a later failure.
    expect((result.sessionParams as { messages: unknown[] }).messages.length).toBeGreaterThan(0);
  });

  it("surfaces a rate limit as provider_quota with the retry instant", async () => {
    const fetchImpl = vi.fn(async () =>
      chatResponse({ error: { message: "slow down" } }, { status: 429, headers: { "retry-after": "30" } }),
    ) as unknown as typeof fetch;

    const result = await execute(makeCtx({ fetchImpl }));

    expect(result.errorFamily).toBe("provider_quota");
    expect(result.retryNotBefore).toBeTruthy();
  });

  it("reports a refusal as model_refusal so the run does not retry into it", async () => {
    const fetchImpl = vi.fn(async () =>
      chatResponse({ choices: [{ finish_reason: "content_filter", message: { content: "" } }] }),
    ) as unknown as typeof fetch;

    const result = await execute(makeCtx({ fetchImpl }));
    expect(result.errorFamily).toBe("model_refusal");
  });
});

describe("error classification", () => {
  it("names a connection-refused transport error usefully", () => {
    const classified = classifyTransportError(
      Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" }),
    );
    expect(classified.errorCode).toBe("provider_unreachable");
    expect(classified.errorFamily).toBe("transient_upstream");
    expect(classified.message).toContain("local model server");
  });

  it("explains a 404 as a likely base-URL mistake", () => {
    const classified = classifyProviderError({ status: 404, body: "" });
    expect(classified.message).toContain("/v1");
    // Not retryable: a wrong URL does not fix itself.
    expect(classified.errorFamily).toBeNull();
  });

  it("treats an insufficient-quota body as quota even on an odd status", () => {
    const classified = classifyProviderError({
      status: 403,
      body: '{"error":{"message":"insufficient_quota"}}',
    });
    expect(classified.errorFamily).toBe("provider_quota");
  });

  it("does not guess a retry family for an unrecognised 4xx", () => {
    expect(classifyProviderError({ status: 422, body: "" }).errorFamily).toBeNull();
  });
});
