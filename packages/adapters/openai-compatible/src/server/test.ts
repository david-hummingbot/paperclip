import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { readProviderConnection } from "./execute.js";
import { endpointUrl } from "./wire.js";

function summarize(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function isLoopbackHost(host: string): boolean {
  const lower = host.toLowerCase();
  return (
    lower === "localhost" ||
    lower === "127.0.0.1" ||
    lower === "::1" ||
    lower === "[::1]" ||
    lower.endsWith(".localhost")
  );
}

/**
 * Probes the connection this agent would use.
 *
 * `GET {baseUrl}/models` is the cheapest call that proves all three things at
 * once: the host is reachable, the path prefix is right, and the key is
 * accepted. A local server that does not implement it still answers, which is
 * enough to distinguish "not running" from "running but wrong path".
 */
export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext & { fetchImpl?: typeof fetch },
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config =
    ctx.config && typeof ctx.config === "object" ? (ctx.config as Record<string, unknown>) : {};
  const connection = readProviderConnection(config);
  const testedAt = () => new Date().toISOString();

  if (!connection) {
    checks.push({
      code: "provider_connection_missing",
      level: "error",
      message: "This agent has no provider connection.",
      hint: "Select a provider connection on the agent, or create one under the company's provider connections.",
    });
    return { adapterType: ctx.adapterType, status: summarize(checks), checks, testedAt: testedAt() };
  }

  if (connection.wire !== "openai_chat" && connection.wire !== "openai_responses") {
    checks.push({
      code: "provider_wire_unsupported",
      level: "error",
      message: `This adapter speaks openai_chat and openai_responses, not "${connection.wire}".`,
    });
    return { adapterType: ctx.adapterType, status: summarize(checks), checks, testedAt: testedAt() };
  }

  let url: URL;
  try {
    url = new URL(connection.baseUrl);
  } catch {
    checks.push({
      code: "provider_base_url_invalid",
      level: "error",
      message: `"${connection.baseUrl}" is not an absolute URL.`,
    });
    return { adapterType: ctx.adapterType, status: summarize(checks), checks, testedAt: testedAt() };
  }

  if (isLoopbackHost(url.hostname)) {
    // The probe runs on the Paperclip host. For an agent with its own
    // computer, "localhost" is a different machine, so a pass here does not
    // prove the agent can reach it.
    checks.push({
      code: "provider_base_url_loopback",
      level: "info",
      message:
        "This endpoint is on the machine running the probe. An agent with a Docker or SSH computer resolves this name on that computer instead.",
      hint: "For a Docker agent use host.docker.internal; for an SSH agent use an address reachable from that host.",
    });
  }

  if (!connection.apiKey && !isLoopbackHost(url.hostname)) {
    checks.push({
      code: "provider_key_missing",
      level: "warn",
      message: "This connection has no API key and is not a local endpoint.",
    });
  }

  const fetchImpl = ctx.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(endpointUrl(connection.baseUrl, "/models"), {
      method: "GET",
      headers: {
        ...connection.headers,
        ...(connection.apiKey ? { authorization: `Bearer ${connection.apiKey}` } : {}),
      },
      signal: controller.signal,
    });
    if (response.ok) {
      checks.push({
        code: "provider_reachable",
        level: "info",
        message: `The provider answered ${response.status} at ${connection.baseUrl}.`,
      });
    } else if (response.status === 401 || response.status === 403) {
      checks.push({
        code: "provider_unauthorized",
        level: "error",
        message: `The provider rejected the connection's credentials (HTTP ${response.status}).`,
      });
    } else if (response.status === 404) {
      checks.push({
        code: "provider_models_not_found",
        level: "warn",
        message:
          "The provider is reachable but does not serve /models. This is normal for some local servers; a wrong base URL looks the same, so check the path includes the version segment exactly once.",
      });
    } else {
      checks.push({
        code: "provider_unexpected_status",
        level: "warn",
        message: `The provider answered HTTP ${response.status} at ${connection.baseUrl}.`,
      });
    }
  } catch (error) {
    const aborted = controller.signal.aborted;
    checks.push({
      code: aborted ? "provider_timeout" : "provider_unreachable",
      level: "error",
      message: aborted
        ? "The provider did not answer within 10 seconds."
        : "Could not connect to the provider endpoint.",
      hint: isLoopbackHost(url.hostname)
        ? "If this is a local model server, check it is running and listening on that port."
        : "Check the host is reachable from the Paperclip server.",
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
  }

  return { adapterType: ctx.adapterType, status: summarize(checks), checks, testedAt: testedAt() };
}
