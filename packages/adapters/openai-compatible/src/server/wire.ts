/**
 * Request and response mapping for the two OpenAI-shaped wire formats.
 *
 * Both are kept in one module because the difference between them is narrow —
 * field names and where the tool calls live — and splitting it would mean two
 * near-identical response walkers drifting apart.
 */

export type WireFormat = "openai_chat" | "openai_responses";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Present on an assistant turn that asked for tool calls. */
  toolCalls?: ToolCall[];
  /** Present on a tool result turn, naming the call it answers. */
  toolCallId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON text as the model emitted it; parsed at the call site so a
   *  malformed argument object is reported to the model rather than thrown. */
  argumentsJson: string;
}

export interface CompletionUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export interface CompletionResult {
  text: string;
  toolCalls: ToolCall[];
  usage: CompletionUsage;
  /** The provider's own stop reason, kept verbatim for diagnosis. */
  finishReason: string | null;
  model: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The path appended to the connection's base URL for this wire format. */
export function completionPath(wire: WireFormat): string {
  return wire === "openai_responses" ? "/responses" : "/chat/completions";
}

/**
 * Joins a base URL and a path without letting a trailing slash on the base
 * swallow the last path segment, which is what `new URL(path, base)` does.
 */
export function endpointUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export function buildRequestBody(input: {
  wire: WireFormat;
  model: string;
  messages: readonly ChatMessage[];
  tools: readonly ToolSpec[];
  temperature?: number;
  maxOutputTokens?: number;
}): Record<string, unknown> {
  const tools = input.tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));

  if (input.wire === "openai_responses") {
    return {
      model: input.model,
      input: input.messages.map((message) => toResponsesItem(message)),
      ...(tools.length > 0
        ? {
            // The Responses API flattens the function definition rather than
            // nesting it under `function`.
            tools: input.tools.map((tool) => ({
              type: "function" as const,
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
          }
        : {}),
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
      ...(input.maxOutputTokens === undefined
        ? {}
        : { max_output_tokens: input.maxOutputTokens }),
    };
  }

  return {
    model: input.model,
    messages: input.messages.map((message) => toChatMessage(message)),
    ...(tools.length > 0 ? { tools } : {}),
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...(input.maxOutputTokens === undefined
      ? {}
      : { max_completion_tokens: input.maxOutputTokens }),
  };
}

function toChatMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      // An assistant turn that only asked for tools may carry no prose. The
      // field must still be present, and `null` is what the API expects.
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.argumentsJson },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function toResponsesItem(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      type: "function_call_output",
      call_id: message.toolCallId,
      output: message.content,
    };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    // The Responses API represents a tool request as its own item rather than
    // a field on the assistant turn, so one assistant message with N calls
    // expands to N items. The caller flattens the array.
    return {
      type: "function_call",
      call_id: message.toolCalls[0]!.id,
      name: message.toolCalls[0]!.name,
      arguments: message.toolCalls[0]!.argumentsJson,
    };
  }
  return { role: message.role, content: message.content };
}

export function parseResponse(wire: WireFormat, payload: unknown): CompletionResult {
  return wire === "openai_responses" ? parseResponses(payload) : parseChat(payload);
}

function parseUsage(raw: unknown): CompletionUsage {
  const usage = asRecord(raw);
  const cached =
    asNumber(asRecord(usage.prompt_tokens_details).cached_tokens) ||
    asNumber(asRecord(usage.input_tokens_details).cached_tokens);
  return {
    // `prompt_tokens`/`completion_tokens` is the Chat Completions spelling;
    // `input_tokens`/`output_tokens` is the Responses spelling. Local servers
    // are inconsistent about which they emit, so accept both either way.
    inputTokens: asNumber(usage.prompt_tokens) || asNumber(usage.input_tokens),
    outputTokens: asNumber(usage.completion_tokens) || asNumber(usage.output_tokens),
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
  };
}

function parseChat(payload: unknown): CompletionResult {
  const body = asRecord(payload);
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = asRecord(choices[0]);
  const message = asRecord(choice.message);
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls: ToolCall[] = rawCalls.flatMap((entry, index) => {
    const call = asRecord(entry);
    const fn = asRecord(call.function);
    const name = asText(fn.name);
    if (!name) return [];
    return [
      {
        id: asText(call.id) || `call_${index}`,
        name,
        argumentsJson: asText(fn.arguments) || "{}",
      },
    ];
  });
  return {
    text: asText(message.content),
    toolCalls,
    usage: parseUsage(body.usage),
    finishReason: asText(choice.finish_reason) || null,
    model: asText(body.model) || null,
  };
}

function parseResponses(payload: unknown): CompletionResult {
  const body = asRecord(payload);
  const output = Array.isArray(body.output) ? body.output : [];
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const [index, entry] of output.entries()) {
    const item = asRecord(entry);
    const type = asText(item.type);
    if (type === "function_call") {
      const name = asText(item.name);
      if (!name) continue;
      toolCalls.push({
        id: asText(item.call_id) || asText(item.id) || `call_${index}`,
        name,
        argumentsJson: asText(item.arguments) || "{}",
      });
      continue;
    }
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      const partRecord = asRecord(part);
      const text = asText(partRecord.text);
      if (text) textParts.push(text);
    }
  }

  // `output_text` is the convenience aggregate; prefer it when the server
  // provides it and fall back to walking the content parts.
  const aggregate = asText(body.output_text);
  return {
    text: aggregate || textParts.join(""),
    toolCalls,
    usage: parseUsage(body.usage),
    finishReason: asText(body.status) || null,
    model: asText(body.model) || null,
  };
}

/** Expands an assistant turn with N tool calls into N Responses items. */
export function flattenResponsesInput(
  messages: readonly ChatMessage[],
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 1) {
      for (const call of message.toolCalls!) {
        out.push({ ...message, toolCalls: [call] });
      }
      continue;
    }
    out.push(message);
  }
  return out;
}
