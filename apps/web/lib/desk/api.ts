// The desk talks to its own API through the published SDK client (same origin).
import { SlipwayApiError, SlipwayClient } from "@slipway/sdk";
import type { ApiFailure } from "./types";

export const client = new SlipwayClient();

export function failure(e: unknown): ApiFailure {
  if (e instanceof SlipwayApiError)
    return {
      status: e.status,
      code: e.code,
      message: e.body?.error.message ?? e.message,
      sources: e.body?.sources ?? [],
    };
  if (e instanceof DOMException && e.name === "AbortError")
    return { status: 0, code: "ABORTED", message: "request cancelled", sources: [] };
  return {
    status: 0,
    code: "NETWORK",
    message: e instanceof Error ? e.message : "network error",
    sources: [],
  };
}

/** The error a chat request failed with, in the desk's words. */
export function chatFailure(
  e: Error | undefined,
): { message: string; retryable: boolean; rateLimited: boolean } | null {
  if (!e) return null;
  const err = e as Error & { statusCode?: number; responseBody?: string };
  let message = err.message;
  try {
    const body = JSON.parse(err.responseBody ?? err.message) as { error?: { message?: string } };
    if (body?.error?.message) message = body.error.message;
  } catch {
    // not JSON: keep the transport's message
  }
  const status = err.statusCode ?? 0;
  if (status === 429 || /too many requests/i.test(message))
    return {
      message:
        "The desk answers six questions a minute per visitor. Wait a minute and send again; the order line above the canvas prices without the model.",
      retryable: true,
      rateLimited: true,
    };
  if (/conversation too long/i.test(message))
    return {
      message: "This conversation is too long for the desk. Start a new one.",
      retryable: false,
      rateLimited: false,
    };
  if (status >= 500 || status === 0)
    return {
      message: `The model route failed (${status || "network"}): ${message.slice(0, 160)}. Send again, or price from the order line.`,
      retryable: true,
      rateLimited: false,
    };
  return { message: message.slice(0, 200), retryable: true, rateLimited: false };
}
