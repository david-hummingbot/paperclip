import { describe, expect, it } from "vitest";
import {
  buildRequestBody,
  endpointUrl,
  flattenResponsesInput,
  parseResponse,
  type ChatMessage,
} from "./wire.js";

describe("endpointUrl", () => {
  it("does not let a trailing slash swallow the path", () => {
    // `new URL("/chat/completions", "http://h/v1/")` would drop `/v1`.
    expect(endpointUrl("http://localhost:1234/v1/", "/chat/completions")).toBe(
      "http://localhost:1234/v1/chat/completions",
    );
    expect(endpointUrl("http://localhost:1234/v1", "/chat/completions")).toBe(
      "http://localhost:1234/v1/chat/completions",
    );
  });
});

describe("chat completions wire", () => {
  it("nests the function definition and omits tools when there are none", () => {
    const withTools = buildRequestBody({
      wire: "openai_chat",
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "t", description: "d", parameters: { type: "object" } }],
    });
    expect(withTools.tools).toEqual([
      { type: "function", function: { name: "t", description: "d", parameters: { type: "object" } } },
    ]);

    const withoutTools = buildRequestBody({
      wire: "openai_chat",
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });
    expect(withoutTools).not.toHaveProperty("tools");
  });

  it("sends null content for a tool-only assistant turn", () => {
    const body = buildRequestBody({
      wire: "openai_chat",
      model: "m",
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "t", argumentsJson: "{}" }] },
      ],
      tools: [],
    });
    const message = (body.messages as Record<string, unknown>[])[0]!;
    // The field must be present; an empty string is not what the API expects.
    expect(message.content).toBeNull();
    expect(message.tool_calls).toEqual([
      { id: "c1", type: "function", function: { name: "t", arguments: "{}" } },
    ]);
  });

  it("parses text, tool calls and usage", () => {
    const result = parseResponse("openai_chat", {
      model: "served-model",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: "thinking",
            tool_calls: [
              { id: "c1", function: { name: "connections_search", arguments: '{"query":"x"}' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } },
    });
    expect(result.text).toBe("thinking");
    expect(result.toolCalls).toEqual([
      { id: "c1", name: "connections_search", argumentsJson: '{"query":"x"}' },
    ]);
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 3, cachedInputTokens: 4 });
    expect(result.model).toBe("served-model");
  });

  it("accepts the Responses token spelling from a local server", () => {
    // Local servers are inconsistent about which usage spelling they emit.
    const result = parseResponse("openai_chat", {
      choices: [{ message: { content: "ok" } }],
      usage: { input_tokens: 7, output_tokens: 2 },
    });
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 2 });
  });

  it("drops a tool call with no function name instead of inventing one", () => {
    const result = parseResponse("openai_chat", {
      choices: [{ message: { content: "", tool_calls: [{ id: "c1", function: {} }] } }],
    });
    expect(result.toolCalls).toEqual([]);
  });
});

describe("responses wire", () => {
  it("flattens the function definition and uses max_output_tokens", () => {
    const body = buildRequestBody({
      wire: "openai_responses",
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "t", description: "d", parameters: { type: "object" } }],
      maxOutputTokens: 100,
    });
    expect(body.tools).toEqual([
      { type: "function", name: "t", description: "d", parameters: { type: "object" } },
    ]);
    expect(body.max_output_tokens).toBe(100);
    expect(body).not.toHaveProperty("messages");
  });

  it("represents a tool result as a function_call_output item", () => {
    const body = buildRequestBody({
      wire: "openai_responses",
      model: "m",
      messages: [{ role: "tool", content: '{"ok":true}', toolCallId: "c1" }],
      tools: [],
    });
    expect((body.input as unknown[])[0]).toEqual({
      type: "function_call_output",
      call_id: "c1",
      output: '{"ok":true}',
    });
  });

  it("expands one assistant turn with several calls into several items", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c1", name: "a", argumentsJson: "{}" },
          { id: "c2", name: "b", argumentsJson: "{}" },
        ],
      },
    ];
    // The Responses API has no multi-call assistant item, so the pair has to
    // become two items or the second call is lost.
    const flattened = flattenResponsesInput(messages);
    expect(flattened).toHaveLength(2);
    expect(flattened[0]!.toolCalls).toEqual([{ id: "c1", name: "a", argumentsJson: "{}" }]);
    expect(flattened[1]!.toolCalls).toEqual([{ id: "c2", name: "b", argumentsJson: "{}" }]);
  });

  it("prefers output_text and falls back to walking content parts", () => {
    expect(
      parseResponse("openai_responses", {
        output_text: "aggregate",
        output: [{ content: [{ text: "part" }] }],
      }).text,
    ).toBe("aggregate");

    expect(
      parseResponse("openai_responses", {
        output: [{ content: [{ text: "one " }, { text: "two" }] }],
      }).text,
    ).toBe("one two");
  });

  it("reads a function_call item", () => {
    const result = parseResponse("openai_responses", {
      status: "completed",
      output: [{ type: "function_call", call_id: "c9", name: "t", arguments: '{"a":1}' }],
      usage: { input_tokens: 5, output_tokens: 1 },
    });
    expect(result.toolCalls).toEqual([{ id: "c9", name: "t", argumentsJson: '{"a":1}' }]);
    expect(result.finishReason).toBe("completed");
  });
});
