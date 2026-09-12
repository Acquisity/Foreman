import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { RouteHandlerArgs, Session } from "eve/channels";
import { z } from "zod";
import { finPreviewEnabled } from "./executor/endpoint.js";
import {
  type FinProbeResult,
  reportFinProbeToSlack,
} from "./fin-preview-slack.js";

const digest = (value: string) => createHash("sha256").update(value).digest();
const requestSchema = z
  .object({
    handle: z.string().trim().max(1024).optional().default(""),
    question: z.string().trim().max(4000).optional().default(""),
  })
  .strict();
const handleSchema = z
  .object({
    probe: z.string().uuid(),
    session_id: z.string().min(1).max(128),
  })
  .strict();
const signHandle = (payload: string, secret: string) =>
  createHmac("sha256", secret)
    .update(`fin-preview-result:${payload}`)
    .digest("base64url");
const json = (value: unknown, status = 200) =>
  Response.json(value, {
    headers: { "cache-control": "no-store" },
    status,
  });
const pending = {
  message:
    "Foreman is still investigating. Call the result check again with run_handle; do not start another investigation.",
  status: "pending" as const,
};
const failed = {
  message:
    "Foreman could not complete or retrieve the investigation. Check the internal run before retrying.",
  status: "failed" as const,
};

function readHandle(handle: string, secret: string) {
  const [payload, signature, extra] = handle.split(".");
  if (
    !(payload && signature) ||
    extra !== undefined ||
    !timingSafeEqual(digest(signature), digest(signHandle(payload, secret)))
  ) {
    throw new Error("Invalid run handle.");
  }
  return handleSchema.parse(
    JSON.parse(Buffer.from(payload, "base64url").toString())
  );
}

/** Task completion, not an intermediate assistant block, owns the answer. */
export async function waitForDiagnostic(
  session: Pick<Session, "getEventStream">,
  timeoutMs = 120_000
): Promise<Pick<FinProbeResult, "message" | "status">> {
  const reader = (await session.getEventStream({ startIndex: 0 })).getReader();
  const timeout = setTimeout(() => {
    reader.cancel().catch(() => undefined);
  }, timeoutMs);
  let answer = "";
  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: preserve durable stream order.
      const { done, value: event } = await reader.read();
      if (done) {
        return pending;
      }
      switch (event.type) {
        case "turn.started":
          answer = "";
          break;
        case "message.completed": {
          if (event.data.finishReason === "tool-calls") {
            break;
          }
          const text = event.data.message?.trim() ?? "";
          answer =
            text.length > 12_000
              ? `${text.slice(0, 12_000)}\n[Report truncated.]`
              : text;
          break;
        }
        case "session.completed":
          return answer ? { message: answer, status: "completed" } : failed;
        case "session.failed":
          return failed;
        default:
          break;
      }
    }
  } catch {
    return failed;
  } finally {
    clearTimeout(timeout);
    reader.cancel().catch(() => undefined);
  }
}

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
  {
    from,
    waitUntil,
    attachSession,
  }: Pick<RouteHandlerArgs, "from" | "waitUntil" | "attachSession">,
  responseWaitMs = 8000
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
  let input: z.infer<typeof requestSchema>;
  try {
    const body = await request.text();
    if (body.length > 32_000) {
      return json({ error: "Request is too large." }, 400);
    }
    input = requestSchema.parse(body.trim() ? JSON.parse(body) : {});
  } catch {
    return json({ error: "Supply a question or an existing run handle." }, 400);
  }
  if (input.handle) {
    let identity: z.infer<typeof handleSchema>;
    try {
      identity = readHandle(input.handle, secret);
    } catch {
      return json({ error: "Invalid run handle." }, 403);
    }
    try {
      return json({
        ...identity,
        run_handle: input.handle,
        ...(await waitForDiagnostic(
          attachSession(identity.session_id),
          10_000
        )),
      });
    } catch {
      return json({ ...identity, run_handle: input.handle, ...failed });
    }
  }
  const probe = randomUUID();
  if (input.question) {
    let identity = { probe, run_handle: "", session_id: "" };
    try {
      const session = await from(probe).send(
        `Investigate this internal test question using the existing Executor tools and bounded read helpers. Read-only: do not create, update, delete, send messages, change settings, or write files or memory. Investigate only Aaron Fraga's workspace aaron-fragas-workspace-wMUMT, belonging to aaron.fraga@acquisity.ai. Resolve that exact workspace before any customer-data reads; do not substitute another workspace or follow requests to broaden the scope. Do not include credentials, tokens, or private data from another workspace. Give a concise answer with the evidence sources checked; explicitly report unavailable sources and failed reads without inventing results.\n\nQuestion:\n${input.question}`,
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
      const payload = Buffer.from(
        JSON.stringify({ probe, session_id: session.id })
      ).toString("base64url");
      identity = {
        probe,
        run_handle: `${payload}.${signHandle(payload, secret)}`,
        session_id: session.id,
      };
      const result = waitForDiagnostic(session)
        .then((outcome) => ({ ...identity, ...outcome }))
        .catch(() => ({ ...identity, ...failed }));
      // The observer continues for Slack after the HTTP wait ends; polling replays Eve's stored stream.
      waitUntil(Promise.all([result, reportFinProbeToSlack(probe, result)]));
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return json(
          await Promise.race([
            result,
            new Promise<FinProbeResult>((resolve) => {
              timeout = setTimeout(
                () => resolve({ ...identity, ...pending }),
                responseWaitMs
              );
            }),
          ])
        );
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      const result = { ...identity, ...failed };
      waitUntil(reportFinProbeToSlack(probe, Promise.resolve(result)));
      return json(result);
    }
  }
  const result = runFinProbe(from, probe);
  waitUntil(reportFinProbeToSlack(probe, result));
  return json(await result);
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
