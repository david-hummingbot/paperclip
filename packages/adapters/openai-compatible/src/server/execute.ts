import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { selectPaperclipPromptSections } from "@paperclipai/adapter-utils/server-utils";
import {
  classifyFinishReason,
  classifyProviderError,
  classifyTransportError,
} from "./errors.js";
import { executeToolCall, runtimeToolSpecs } from "./tools.js";
import {
  buildRequestBody,
  completionPath,
  endpointUrl,
  flattenResponsesInput,
  parseResponse,
  type ChatMessage,
  type WireFormat,
} from "./wire.js";

/**
 * The resolved provider endpoint, injected into the agent's runtime config by
 * the server just before dispatch. The adapter never reads a secret store or
 * the database itself — the host resolves `apiKeySecretRef` and hands over the
 * value, the same division of labour every other adapter follows.
 */
export interface ResolvedProviderConnection {
  id: string;
  name: string;
  wire: WireFormat | "anthropic" | "acp";
  baseUrl: string;
  apiKey: string | null;
  headers: Record<string, string>;
}

/** How many assistant→tool→assistant cycles one run may take. */
const DEFAULT_MAX_TOOL_ROUNDS = 8;
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function asPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function readProviderConnection(
  config: Record<string, unknown>,
): ResolvedProviderConnection | null {
  const raw = asRecord(config.paperclipProviderConnection);
  const baseUrl = asString(raw.baseUrl);
  const wire = asString(raw.wire);
  if (!baseUrl || !wire) return null;
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(asRecord(raw.headers))) {
    if (typeof value === "string") headers[key] = value;
  }
  return {
    id: asString(raw.id),
    name: asString(raw.name, "provider"),
    wire: wire as ResolvedProviderConnection["wire"],
    baseUrl,
    apiKey: typeof raw.apiKey === "string" && raw.apiKey.length > 0 ? raw.apiKey : null,
    headers,
  };
}

/**
 * Rebuilds the conversation for this run.
 *
 * A resumed session replays its stored transcript so the model keeps its
 * context; a fresh session starts from the system prompt. The transcript is
 * stored in `sessionParams`, which the host persists on `agent_task_sessions`
 * and keys by task — so an agent's room conversation and its review
 * conversation stay separate without this adapter knowing rooms exist.
 */
export function buildMessages(input: {
  context: Record<string, unknown>;
  storedMessages: readonly ChatMessage[];
  systemPrompt: string;
}): ChatMessage[] {
  const resumed = input.storedMessages.length > 0;
  const { taskContextNote, wakePrompt } = selectPaperclipPromptSections(input.context, {
    resumedSession: resumed,
  });
  const turn = [taskContextNote, wakePrompt].filter((part) => part.trim().length > 0).join("\n\n");

  if (resumed) {
    return [...input.storedMessages, { role: "user", content: turn }];
  }
  return [
    { role: "system", content: input.systemPrompt },
    { role: "user", content: turn },
  ];
}

function readStoredMessages(runtimeSessionParams: unknown): ChatMessage[] {
  const params = asRecord(runtimeSessionParams);
  const raw = params.messages;
  if (!Array.isArray(raw)) return [];
  const out: ChatMessage[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    const role = asString(record.role);
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") continue;
    out.push({
      role,
      content: asString(record.content),
      ...(Array.isArray(record.toolCalls)
        ? {
            toolCalls: record.toolCalls.flatMap((call) => {
              const callRecord = asRecord(call);
              const name = asString(callRecord.name);
              if (!name) return [];
              return [
                {
                  id: asString(callRecord.id, "call"),
                  name,
                  argumentsJson: asString(callRecord.argumentsJson, "{}"),
                },
              ];
            }),
          }
        : {}),
      ...(record.toolCallId === undefined ? {} : { toolCallId: asString(record.toolCallId) }),
    });
  }
  return out;
}

const DEFAULT_SYSTEM_PROMPT = [
  "You are an agent working inside Paperclip, a control plane for AI-agent companies.",
  "You receive one task at a time and answer it in full. Be concrete and brief.",
  "You have no file system or shell access in this harness. If a task needs to read or change files, say so plainly instead of pretending to have done it.",
].join(" ");

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = asRecord(ctx.config);
  const context = asRecord(ctx.context);
  const connection = readProviderConnection(config);

  if (!connection) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "provider_connection_missing",
      errorMessage:
        "This agent has no provider connection. Select one on the agent before running it.",
    };
  }
  if (connection.wire !== "openai_chat" && connection.wire !== "openai_responses") {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "provider_wire_unsupported",
      errorMessage: `The openai_compatible adapter speaks openai_chat and openai_responses, not "${connection.wire}".`,
    };
  }

  const model = asString(config.model);
  if (!model) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "model_missing",
      errorMessage: "This agent has no model configured.",
    };
  }

  const wire: WireFormat = connection.wire;
  const fetchImpl = (config.paperclipFetchImpl as typeof fetch | undefined) ?? fetch;
  const maxToolRounds = asPositiveNumber(config.maxToolRounds, DEFAULT_MAX_TOOL_ROUNDS);
  const timeoutMs = asPositiveNumber(config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const tools = runtimeToolSpecs(ctx.runtimeTools);

  let messages = buildMessages({
    context,
    storedMessages: readStoredMessages(ctx.runtime.sessionParams),
    systemPrompt: asString(config.systemPrompt, DEFAULT_SYSTEM_PROMPT),
  });

  const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let finalText = "";
  let reportedModel: string | null = null;
  let toolRounds = 0;

  // No child process, so nothing will emit a spawn event. Report dispatch here
  // so the host's gate releases before the first request rather than after it.
  ctx.onDispatch?.();
  await ctx.onCancellationReady?.();

  for (;;) {
    if (ctx.signal?.aborted) {
      return {
        exitCode: null,
        signal: "SIGTERM",
        timedOut: false,
        errorCode: "cancelled",
        errorMessage: "The run was cancelled.",
        sessionParams: { messages },
      };
    }

    const body = buildRequestBody({
      wire,
      model,
      messages: wire === "openai_responses" ? flattenResponsesInput(messages) : messages,
      tools,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    let response: Response;
    try {
      response = await fetchImpl(endpointUrl(connection.baseUrl, completionPath(wire)), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...connection.headers,
          // Auth comes from the resolved connection key and overrides any
          // operator header, which the validator refuses anyway.
          ...(connection.apiKey ? { authorization: `Bearer ${connection.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = controller.signal.aborted && !ctx.signal?.aborted;
      const classified = classifyTransportError(error);
      return {
        exitCode: null,
        signal: null,
        timedOut,
        errorCode: timedOut ? "provider_timeout" : classified.errorCode,
        errorFamily: classified.errorFamily,
        errorMessage: timedOut
          ? `The provider did not respond within ${timeoutMs}ms.`
          : classified.message,
        // Persist what was said so far: a transport failure mid-conversation
        // should not silently discard the turns that already succeeded.
        sessionParams: { messages },
        ...(usage.inputTokens || usage.outputTokens ? { usage, usageBasis: "per_run" as const } : {}),
      };
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
    }

    const rawBody = await response.text();
    if (!response.ok) {
      const classified = classifyProviderError({
        status: response.status,
        body: rawBody,
        retryAfterHeader: response.headers.get("retry-after"),
      });
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: classified.errorCode,
        errorFamily: classified.errorFamily,
        errorMessage: classified.message,
        ...(classified.retryNotBefore ? { retryNotBefore: classified.retryNotBefore } : {}),
        sessionParams: { messages },
        ...(usage.inputTokens || usage.outputTokens ? { usage, usageBasis: "per_run" as const } : {}),
      };
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "provider_invalid_response",
        errorFamily: "transient_upstream",
        errorMessage: "The provider returned a body that is not JSON.",
        sessionParams: { messages },
      };
    }

    const completion = parseResponse(wire, parsedBody);
    usage.inputTokens += completion.usage.inputTokens;
    usage.outputTokens += completion.usage.outputTokens;
    usage.cachedInputTokens += completion.usage.cachedInputTokens ?? 0;
    reportedModel = completion.model ?? reportedModel;

    const refusal = classifyFinishReason(completion.finishReason);
    if (refusal) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: refusal.errorCode,
        errorFamily: refusal.errorFamily,
        errorMessage: refusal.message,
        sessionParams: { messages },
        usage,
        usageBasis: "per_run",
        model: reportedModel ?? model,
      };
    }

    messages = [
      ...messages,
      {
        role: "assistant",
        content: completion.text,
        ...(completion.toolCalls.length > 0 ? { toolCalls: completion.toolCalls } : {}),
      },
    ];

    if (completion.text.trim()) {
      await ctx.onLog("stdout", `${completion.text}\n`);
      finalText = completion.text;
    }

    if (completion.toolCalls.length === 0) break;

    toolRounds += 1;
    if (toolRounds > maxToolRounds) {
      // Stop rather than loop: a model that keeps calling tools without
      // concluding will otherwise burn the budget silently.
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "tool_round_limit",
        errorMessage: `The model made more than ${maxToolRounds} rounds of tool calls without finishing.`,
        sessionParams: { messages },
        usage,
        usageBasis: "per_run",
        model: reportedModel ?? model,
        summary: finalText || null,
      };
    }

    const access = ctx.runtimeTools;
    for (const call of completion.toolCalls) {
      const result = access
        ? await executeToolCall({
            access,
            name: call.name,
            argumentsJson: call.argumentsJson,
            // Same fetch as the completion call, so a caller that injects one
            // (a test, or a future proxy) covers the whole adapter rather than
            // only half of it.
            fetchImpl,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          })
        : {
            ok: false,
            content: JSON.stringify({ error: "No Paperclip tools are available in this run." }),
          };
      await ctx.onLog("stdout", `[tool] ${call.name} → ${result.ok ? "ok" : "error"}\n`);
      messages = [
        ...messages,
        { role: "tool", content: result.content, toolCallId: call.id },
      ];
    }
  }

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    usage,
    // Totals are for this execution only; the host must not delta them
    // against the previous run on the same session.
    usageBasis: "per_run",
    model: reportedModel ?? model,
    provider: connection.name,
    billingType: connection.apiKey ? "api" : "fixed",
    sessionParams: { messages },
    sessionDisplayId: connection.id ? `${connection.name}:${model}` : model,
    summary: finalText || null,
  };
}
