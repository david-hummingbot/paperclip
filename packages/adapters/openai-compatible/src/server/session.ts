import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

/**
 * The session blob is the conversation transcript.
 *
 * There is no provider-side session to resume — a completions endpoint is
 * stateless — so the transcript itself is the session. The host keys it by
 * task on `agent_task_sessions`, which is what keeps an agent's room
 * conversation separate from its review conversation without this adapter
 * knowing either exists.
 */
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    return Array.isArray(record.messages) ? { messages: record.messages } : null;
  },
  serialize(params) {
    if (!params) return null;
    return Array.isArray(params.messages) ? { messages: params.messages } : null;
  },
};
