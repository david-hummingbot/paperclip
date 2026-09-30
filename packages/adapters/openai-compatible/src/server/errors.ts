import type { AdapterExecutionErrorFamily } from "@paperclipai/adapter-utils";

export interface ClassifiedProviderError {
  errorCode: string;
  errorFamily: AdapterExecutionErrorFamily | null;
  /** When the provider named a retry time, the ISO instant to wait until. */
  retryNotBefore?: string;
  message: string;
}

/**
 * Maps an HTTP status and response body onto Paperclip's error families.
 *
 * The families matter: `provider_quota` pauses and schedules a retry rather
 * than failing the run, and `transient_upstream` is retried. Everything else
 * is a terminal failure, so anything ambiguous stays unclassified rather than
 * being guessed into a retry loop.
 */
export function classifyProviderError(input: {
  status: number;
  body: string;
  retryAfterHeader?: string | null;
  now?: () => number;
}): ClassifiedProviderError {
  const now = input.now ?? Date.now;
  const detail = extractMessage(input.body);

  if (input.status === 429) {
    return {
      errorCode: "provider_rate_limited",
      errorFamily: "provider_quota",
      ...(resolveRetryAt(input.retryAfterHeader, now) ?? {}),
      message: detail || "The provider rate-limited this request.",
    };
  }

  // 402 is the usual "out of credits" answer; some OpenAI-compatible gateways
  // use 403 with an insufficient-quota code instead.
  if (input.status === 402 || /insufficient[_ ]quota|billing|credit/i.test(input.body)) {
    return {
      errorCode: "provider_quota_exhausted",
      errorFamily: "provider_quota",
      message: detail || "The provider reported no remaining quota.",
    };
  }

  if (input.status === 401 || input.status === 403) {
    return {
      errorCode: "provider_unauthorized",
      errorFamily: null,
      message:
        detail || "The provider rejected the connection's credentials.",
    };
  }

  if (input.status === 404) {
    return {
      errorCode: "provider_endpoint_not_found",
      errorFamily: null,
      // The most common cause by far is a base URL missing or duplicating the
      // version segment, so say that instead of only echoing 404.
      message:
        detail ||
        "The provider returned 404. Check the connection's base URL includes the version segment (for example /v1) exactly once.",
    };
  }

  if (input.status === 408 || input.status === 409 || input.status >= 500) {
    return {
      errorCode: `provider_http_${input.status}`,
      errorFamily: "transient_upstream",
      message: detail || `The provider returned HTTP ${input.status}.`,
    };
  }

  return {
    errorCode: `provider_http_${input.status}`,
    errorFamily: null,
    message: detail || `The provider returned HTTP ${input.status}.`,
  };
}

/** A network-level failure, before any HTTP status exists. */
export function classifyTransportError(error: unknown): ClassifiedProviderError {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "";

  // A local model server that is not running is the single most common
  // failure for this adapter, and "fetch failed" alone sends people hunting
  // in the wrong place.
  if (code === "ECONNREFUSED" || /ECONNREFUSED|connect(ion)? refused/i.test(message)) {
    return {
      errorCode: "provider_unreachable",
      errorFamily: "transient_upstream",
      message:
        "Could not connect to the provider endpoint. If this is a local model server, check it is running and that the base URL's host is reachable from the agent's computer.",
    };
  }
  if (code === "ENOTFOUND" || /ENOTFOUND|getaddrinfo/i.test(message)) {
    return {
      errorCode: "provider_host_not_found",
      errorFamily: "transient_upstream",
      message: "Could not resolve the provider endpoint's host name.",
    };
  }
  return {
    errorCode: "provider_transport_error",
    errorFamily: "transient_upstream",
    message,
  };
}

/**
 * A completion that stopped for a provider-side policy reason rather than
 * finishing. Reported as `model_refusal` so the run does not retry into the
 * same refusal.
 */
export function classifyFinishReason(
  finishReason: string | null,
): ClassifiedProviderError | null {
  if (!finishReason) return null;
  if (/content_filter|refusal|safety/i.test(finishReason)) {
    return {
      errorCode: "model_refusal",
      errorFamily: "model_refusal",
      message: `The provider stopped the completion (${finishReason}).`,
    };
  }
  return null;
}

function extractMessage(body: string): string {
  if (!body) return "";
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const error = record.error;
      if (typeof error === "string") return error;
      if (error && typeof error === "object") {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === "string") return message;
      }
      if (typeof record.message === "string") return record.message;
    }
  } catch {
    // Not JSON. Fall through to the truncated raw body.
  }
  const trimmed = body.trim();
  return trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed;
}

function resolveRetryAt(
  header: string | null | undefined,
  now: () => number,
): { retryNotBefore: string } | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return { retryNotBefore: new Date(now() + seconds * 1000).toISOString() };
  }
  const at = Date.parse(header);
  return Number.isFinite(at) ? { retryNotBefore: new Date(at).toISOString() } : null;
}
