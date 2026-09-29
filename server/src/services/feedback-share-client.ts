import { gzipSync } from "node:zlib";
import type { FeedbackTraceBundle } from "@paperclipai/shared";
import type { Config } from "../config.js";

function buildFeedbackShareObjectKey(bundle: FeedbackTraceBundle, exportedAt: Date) {
  const year = String(exportedAt.getUTCFullYear());
  const month = String(exportedAt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(exportedAt.getUTCDate()).padStart(2, "0");
  return `feedback-traces/${bundle.companyId}/${year}/${month}/${day}/${bundle.exportId ?? bundle.traceId}.json`;
}

export interface FeedbackTraceShareClient {
  uploadTraceBundle(bundle: FeedbackTraceBundle): Promise<{ objectKey: string }>;
}

/**
 * Returns `undefined` when no export backend is configured. This fork ships no
 * default destination, so feedback traces stay in the instance database unless
 * an operator points `PAPERCLIP_FEEDBACK_EXPORT_BACKEND_URL` at a host they
 * run. `flushPendingFeedbackTraces` already handles a missing client by
 * marking rows with the "backend not configured" reason.
 */
export function createFeedbackTraceShareClientFromConfig(
  config: Pick<Config, "feedbackExportBackendUrl" | "feedbackExportBackendToken">,
): FeedbackTraceShareClient | undefined {
  const baseUrl = config.feedbackExportBackendUrl?.trim();
  if (!baseUrl) return undefined;
  const token = config.feedbackExportBackendToken?.trim();
  const endpoint = new URL("/feedback-traces", baseUrl).toString();

  return {
    async uploadTraceBundle(bundle) {
      const exportedAt = new Date();
      const objectKey = buildFeedbackShareObjectKey(bundle, exportedAt);
      const requestBody = JSON.stringify({
        objectKey,
        exportedAt: exportedAt.toISOString(),
        bundle,
      });
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          encoding: "gzip+base64+json",
          payload: gzipSync(requestBody).toString("base64"),
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(detail.trim() || `Feedback trace upload failed with HTTP ${response.status}`);
      }

      const payload = await response.json().catch(() => null) as { objectKey?: unknown } | null;
      return {
        objectKey: typeof payload?.objectKey === "string" && payload.objectKey.trim().length > 0
          ? payload.objectKey
          : objectKey,
      };
    },
  };
}
