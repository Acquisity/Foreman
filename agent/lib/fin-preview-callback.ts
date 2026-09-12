import { logOpsEvent } from "./ops-log.js";

export interface FinCallbackState {
  answer: string;
  delivered: boolean;
  url: string;
}

export function createFinCallback(url: string): FinCallbackState | null {
  return url ? { answer: "", delivered: false, url } : null;
}

export const finDiagnosticFailure = {
  message:
    "Foreman could not complete or retrieve the investigation. Check the internal run before retrying.",
  status: "failed" as const,
};

export function boundedFinAnswer(message: string | null | undefined) {
  const answer = message?.trim() ?? "";
  return answer.length > 12_000
    ? `${answer.slice(0, 12_000)}\n[Report truncated.]`
    : answer;
}

const callbackPath = /^\/hooks\/procedures\/callback\/[A-Za-z0-9_-]{1,1024}$/;

export function isFinCallbackUrl(value: string): boolean {
  // Verified in Intercom's generated Procedure callback, not its HITL API.
  const url = URL.parse(value);
  return (
    url?.origin === "https://api.intercom.io" &&
    value === `${url.origin}${url.pathname}` &&
    callbackPath.test(url.pathname)
  );
}

export async function deliverFinCallback(
  state: FinCallbackState | null,
  sessionId: string,
  status: "completed" | "failed",
  request: typeof fetch = fetch
): Promise<void> {
  if (!state || state.delivered) {
    return;
  }
  try {
    if (!isFinCallbackUrl(state.url)) {
      throw new Error("Invalid Fin callback destination.");
    }
    const result =
      status === "completed" && state.answer
        ? { message: state.answer, status }
        : finDiagnosticFailure;
    const response = await request(state.url, {
      body: JSON.stringify(result),
      headers: { "content-type": "application/json" },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error("Fin callback delivery failed.");
    }
    state.delivered = true;
    logOpsEvent("fin_preview_callback_delivered", {
      outcome: result.status,
      sessionId,
    });
  } catch {
    logOpsEvent("fin_preview_callback_failed", {
      message: "Fin preview callback could not be delivered.",
      sessionId,
    });
  }
}
