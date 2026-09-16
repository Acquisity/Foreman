import type { FinCaseOutcome } from "./fin-case.js";
import { logOpsEvent } from "./ops-log.js";

export interface FinInvestigationCallbackState {
  delivered: boolean;
  url: string;
}

export const finInvestigationFailure = {
  message:
    "The investigation could not be completed. No findings are available.",
  status: "failed" as const,
};

export interface FinInvestigationOutcome {
  message: string;
  status: "completed" | "failed";
  ticket?: FinCaseOutcome;
}

type FinInvestigationEvent =
  | {
      type: "message.completed";
      finishReason: string;
      message: string | null;
    }
  | { type: "session.completed" | "session.failed" | "turn.started" };

export function reduceFinEvent(
  answer: string,
  event: FinInvestigationEvent
): { answer: string; outcome: FinInvestigationOutcome | null } {
  if (event.type === "turn.started") {
    return { answer: "", outcome: null };
  }
  if (event.type === "message.completed") {
    return {
      answer:
        event.finishReason === "stop"
          ? boundedFinAnswer(event.message)
          : answer,
      outcome: null,
    };
  }
  if (event.type === "session.failed") {
    return { answer, outcome: finInvestigationFailure };
  }
  return {
    answer,
    outcome: answer
      ? { message: answer, status: "completed" }
      : finInvestigationFailure,
  };
}

export function boundedFinAnswer(message: string | null | undefined) {
  const answer = message?.trim() ?? "";
  return answer.length > 12_000
    ? `${answer.slice(0, 12_000)}\n[Report truncated.]`
    : answer;
}

const callbackPath = /^\/hooks\/procedures\/callback\/[A-Za-z0-9_-]{1,1024}$/;

export function isFinCallbackUrl(value: string): boolean {
  const url = URL.parse(value);
  return (
    url?.origin === "https://api.intercom.io" &&
    value === `${url.origin}${url.pathname}` &&
    callbackPath.test(url.pathname)
  );
}

export const createFinCallback = (
  url: string
): FinInvestigationCallbackState | null =>
  url ? { delivered: false, url } : null;

export async function deliverFinCallback(
  state: FinInvestigationCallbackState | null,
  sessionId: string,
  outcome: FinInvestigationOutcome,
  request: typeof fetch = fetch
): Promise<void> {
  if (!state || state.delivered) {
    return;
  }
  try {
    if (!isFinCallbackUrl(state.url)) {
      throw new Error("Invalid Fin callback destination.");
    }
    const response = await request(state.url, {
      // The connector supplies an untrusted opaque callback URL. Never put customer
      // findings or run references here. The receiving Procedure must authenticate
      // a result lookup using its own native conversation and saved run reference.
      body: JSON.stringify({
        message:
          "Retrieve the investigation result for this conversation with Get Foreman Result before replying. This notification contains no findings.",
        status: "ready",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error("Fin callback delivery failed.");
    }
    state.delivered = true;
    logOpsEvent("fin.investigation.callback.delivered", {
      outcome: outcome.status,
      sessionId,
    });
  } catch {
    logOpsEvent("fin.investigation.callback.failed", {
      message: "Fin investigation callback could not be delivered.",
      sessionId,
    });
  }
}
