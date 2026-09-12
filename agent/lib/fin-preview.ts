import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { RouteHandlerArgs, Session } from "eve/channels";
import { finPreviewEnabled } from "./executor/endpoint.js";
import {
  type FinProbeResult,
  reportFinProbeToSlack,
} from "./fin-preview-slack.js";

const digest = (value: string) => createHash("sha256").update(value).digest();

// Observe only the fixed probe reply. Never return raw agent output to Fin.
export async function waitForProbe(
  session: Pick<Session, "getEventStream">,
  probe: string,
  timeoutMs = 10_000
) {
  const reader = (await session.getEventStream()).getReader();
  const timeout = setTimeout(() => {
    reader.cancel().catch(() => undefined);
  }, timeoutMs);
  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: events must be read in order from one stream.
      const { done, value: event } = await reader.read();
      if (done) {
        return "pending";
      }
      if (
        event.type === "message.completed" &&
        event.data.finishReason !== "tool-calls"
      ) {
        return event.data.message?.trim() === `FOREMAN_CONNECTED:${probe}`
          ? "connected"
          : "unexpected_reply";
      }
      if (event.type === "turn.failed" || event.type === "session.failed") {
        return "failed";
      }
    }
  } finally {
    clearTimeout(timeout);
    reader.cancel().catch(() => undefined);
  }
}

export async function receiveFinProbe(
  request: Request,
  { from, waitUntil }: Pick<RouteHandlerArgs, "from" | "waitUntil">
) {
  const secret = process.env.FIN_FOREMAN_PREVIEW_TOKEN;
  if (!(finPreviewEnabled() && secret)) {
    return new Response(null, { status: 404 });
  }
  if (
    !timingSafeEqual(
      digest(request.headers.get("authorization") ?? ""),
      digest(`Bearer ${secret}`)
    )
  ) {
    return new Response(null, { status: 401 });
  }
  const probe = randomUUID();
  const result = runFinProbe(from, probe);
  waitUntil(reportFinProbeToSlack(probe, result));
  return Response.json(await result, {
    headers: { "cache-control": "no-store" },
  });
}

async function runFinProbe(
  from: RouteHandlerArgs["from"],
  probe: string
): Promise<FinProbeResult> {
  // No request body, conversation, customer identifier, or caller prompt is forwarded.
  const session = await from(probe).send(
    `This is an internal Fin connection test. Do not use tools, consult memory, or investigate anything. Reply with exactly FOREMAN_CONNECTED:${probe}`,
    {
      auth: {
        attributes: {},
        authenticator: "bearer",
        issuer: "foreman:fin-preview",
        principalId: "fin-preview",
        principalType: "service",
      },
      mode: "task",
    }
  );
  const status = await waitForProbe(session, probe);
  const messages = {
    connected:
      "Foreman received this connection test and replied successfully.",
    failed: "Foreman accepted the test, but the agent run failed.",
    pending:
      "Foreman accepted the test. Its reply was not received within this connector call.",
    unexpected_reply:
      "Foreman replied, but did not return the expected connection-test response.",
  };
  return {
    message: messages[status],
    probe,
    session_id: session.id,
    status,
  };
}
