import { createHash } from "node:crypto";
import type { RouteHandlerArgs, Session } from "eve/channels";
import { z } from "zod";
import { readRequestBody } from "./bounded-body.js";
import { logOpsEvent } from "./ops-log.js";
import { verifyWidgetContext } from "./widget-context.js";
import { gate as egressGate, logGateDecision } from "./widget-egress.js";
import { extractWidgetFindings } from "./widget-extract.js";
import { parseFindings, type WidgetFindings } from "./widget-findings.js";
import {
  assertWidgetRunOwner,
  attachWidgetRun,
  claimWidgetRun,
  completeWidgetRun,
  latestWidgetScope,
  readWidgetRun,
  type WidgetOutcome,
  type WidgetRun,
} from "./widget-run-store.js";
import {
  sameWidgetOwner,
  type WidgetContext,
  widgetAuth,
} from "./widget-scope.js";

const bearer = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/;
const scopeFields = {
  conversation_id: z.uuid(),
  organization_id: z.uuid(),
};
const inputSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...scopeFields,
    action: z.literal("start"),
    message_id: z.uuid().optional(),
    question: z.string().trim().min(1).max(4000),
  }),
  z.strictObject({
    ...scopeFields,
    action: z.literal("result"),
    run_id: z.uuid(),
  }),
]);
export type WidgetInput = z.infer<typeof inputSchema>;

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    headers: { "cache-control": "no-store" },
    status,
  });

export const widgetAddress = (scope: {
  organizationId: string;
  conversationId: string;
}) => `${scope.organizationId}:${scope.conversationId}`;

export type WaitOutcome =
  | { status: "pending" }
  | { status: "failed" }
  | {
      findings: WidgetFindings | null;
      status: "completed";
      text: string | null;
    };

const TEXT_MAX = 4000;
const messageText = (data: unknown): string | null => {
  const value = (data as { message?: unknown } | null | undefined)?.message;
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed.slice(0, TEXT_MAX) : null;
};

/**
 * Task completion owns the answer. The structured result is the findings
 * channel; the last assistant message is kept as a fallback so a finish that
 * narrated instead of returning the schema still hands the teammate real prose.
 */
export async function waitForWidgetInvestigation(
  session: Pick<Session, "getEventStream">,
  startIndex = 0,
  timeoutMs = 120_000
): Promise<WaitOutcome> {
  const reader = (await session.getEventStream({ startIndex })).getReader();
  const timeout = setTimeout(
    () => reader.cancel().catch(() => undefined),
    timeoutMs
  );
  let findings: WidgetFindings | null = null;
  let text: string | null = null;
  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: preserve durable stream order.
      const { done, value: event } = await reader.read();
      if (done) {
        return { status: "pending" };
      }
      if (event.type === "turn.started") {
        findings = null;
        text = null;
      } else if (event.type === "result.completed") {
        findings = parseFindings(event.data.result);
      } else if (event.type === "message.completed") {
        text = messageText(event.data) ?? text;
      } else if (event.type === "session.completed") {
        return { findings, status: "completed", text };
      } else if (event.type === "session.failed") {
        return { status: "failed" };
      }
    }
  } catch {
    return { status: "pending" };
  } finally {
    clearTimeout(timeout);
    reader.cancel().catch(() => undefined);
  }
}

export const defaultWidgetDependencies = {
  attach: attachWidgetRun,
  claim: claimWidgetRun,
  complete: completeWidgetRun,
  extract: extractWidgetFindings,
  gate: egressGate,
  latestScope: latestWidgetScope,
  read: readWidgetRun,
};
export type WidgetDependencies = typeof defaultWidgetDependencies;

const disclose = (outcome: WidgetOutcome, findings: unknown) =>
  outcome.decision === "block" ||
  (findings as { needsHuman?: unknown } | null)?.needsHuman === true;

/** Raw findings leave Foreman only on the block path, for the CS inbox note. */
export function widgetRunResponse(run: WidgetRun) {
  if (!run.outcome) {
    return { run_id: run.id, status: "pending" as const };
  }
  return {
    decision: run.outcome.decision,
    message: run.outcome.message,
    run_id: run.id,
    status: run.outcome.status,
    ...(disclose(run.outcome, run.findings) ? { findings: run.findings } : {}),
  };
}

const blockedOutcome = (
  reason: string,
  status: WidgetOutcome["status"]
): WidgetOutcome => ({ decision: "block", message: null, reason, status });

/**
 * A run with no answer after this long is force-finished so the customer never waits forever.
 * ponytail: temporarily raised to just under the Acquisity 4-min poll cap while the findings
 * extractor is being tuned (don't cut real investigations off early). Tune back down (~90s)
 * once extraction latency is understood. The session-failure / no-prose fallback is unaffected.
 */
export const WIDGET_DEADLINE_MS = 280_000;
const DEADLINE_FALLBACK =
  "The investigation did not finish in time. Please review and reply.";

/**
 * A finish that produced no valid structured findings still hands the teammate
 * a note and routes to a human, instead of an empty block or an endless wait.
 * The prose is never composed to the customer; it only fills the CS inbox note.
 */
function humanHandoff(
  text: string | null,
  reason: string
): { findings: WidgetFindings; result: WidgetOutcome } | null {
  const body = (text?.trim() || DEADLINE_FALLBACK).slice(0, 4000);
  const findings = parseFindings({
    confidence: "low",
    facts: [],
    needsHuman: true,
    recommendation: body,
    report: body.slice(0, 1000),
  });
  return findings
    ? {
        findings,
        result: {
          decision: "block",
          message: null,
          reason,
          status: "completed",
        },
      }
    : null;
}

/** Gate, then persist. Runs once per session outcome; a replay finds the fenced row unchanged. */
export async function finishWidgetRun(
  run: Pick<WidgetRun, "id" | "question" | "scope">,
  sessionId: string,
  outcome: WaitOutcome,
  deps: Pick<WidgetDependencies, "complete" | "extract" | "gate">
): Promise<WidgetRun | null> {
  if (outcome.status === "pending") {
    return null;
  }
  let result: WidgetOutcome;
  let findings: unknown = null;
  if (outcome.status === "failed") {
    result = blockedOutcome("session_failed", "failed");
  } else {
    // The investigator writes prose; a separate pass structures it. Any leftover
    // stream-carried findings still work, but the schema no longer fails the session.
    const structured =
      outcome.findings ??
      (outcome.text
        ? await deps.extract({
            investigatorText: outcome.text,
            question: run.question,
            scope: run.scope,
          })
        : null);
    const handoff = structured
      ? null
      : (outcome.text &&
          humanHandoff(outcome.text, "no_structured_findings")) ||
        null;
    if (structured) {
      findings = structured;
      const gated = await deps.gate(run.scope, run.question, structured);
      result = {
        decision: gated.decision,
        message: gated.message,
        reason: gated.reason,
        status: "completed",
      };
    } else if (handoff) {
      ({ findings, result } = handoff);
    } else {
      result = blockedOutcome("invalid_findings", "completed");
    }
  }
  logGateDecision(
    { conversationId: run.scope.conversationId, runId: run.id, sessionId },
    result
  );
  return deps.complete(run.id, result, findings, sessionId);
}

const requestKey = (input: Extract<WidgetInput, { action: "start" }>) =>
  input.message_id ??
  createHash("sha256")
    .update(JSON.stringify([input.conversation_id, input.question]))
    .digest("hex");

/** Advance a still-open run: finish it if it settled, or force a human handoff once overdue. */
async function settleResultRun(
  run: WidgetRun,
  sessionId: string,
  attach: NonNullable<RouteHandlerArgs["attachSession"]>,
  responseWaitMs: number,
  deps: WidgetDependencies
): Promise<WidgetRun> {
  const outcome = await waitForWidgetInvestigation(
    attach(sessionId),
    run.stream_index,
    responseWaitMs
  );
  const overdue = Date.now() - run.created_at.getTime() > WIDGET_DEADLINE_MS;
  const handoff =
    outcome.status === "pending" && overdue
      ? humanHandoff(null, "deadline")
      : null;
  if (handoff) {
    logGateDecision(
      { conversationId: run.scope.conversationId, runId: run.id, sessionId },
      handoff.result
    );
    return (
      (await deps.complete(
        run.id,
        handoff.result,
        handoff.findings,
        sessionId
      )) ?? run
    );
  }
  return (await finishWidgetRun(run, sessionId, outcome, deps)) ?? run;
}

export async function receiveWidgetMessage(
  request: Request,
  {
    from,
    waitUntil,
    attachSession,
    resolveSession,
  }: Pick<RouteHandlerArgs<{ runId: string | null }>, "from" | "waitUntil"> &
    Partial<Pick<RouteHandlerArgs, "attachSession" | "resolveSession">>,
  responseWaitMs = 8000,
  verifyContext = verifyWidgetContext,
  deps: WidgetDependencies = defaultWidgetDependencies
) {
  if (process.env.SUPPORT_CHAT_ENABLED !== "true") {
    return json({ error: "Not found." }, 404);
  }
  const userToken = bearer.exec(
    request.headers.get("authorization") ?? ""
  )?.[1];
  if (!userToken) {
    return json({ error: "Identity required." }, 401);
  }
  let input: WidgetInput;
  try {
    const body = await readRequestBody(request);
    if (body === null) {
      return json({ error: "Request is too large." }, 413);
    }
    const raw = JSON.parse(body);
    input = inputSchema.parse({ action: "start", ...raw });
  } catch {
    return json({ error: "Invalid support request." }, 400);
  }
  let scope: WidgetContext;
  try {
    scope = await verifyContext({
      conversationId: input.conversation_id,
      organizationId: input.organization_id,
      signal: request.signal,
      userToken,
    });
  } catch {
    return json({ error: "Workspace could not be verified." }, 403);
  }
  try {
    if (input.action === "result") {
      let run = await deps.read(input.run_id);
      assertWidgetRunOwner(run, scope);
      if (!run.outcome && run.session_id && attachSession) {
        run = await settleResultRun(
          run,
          run.session_id,
          attachSession,
          responseWaitMs,
          deps
        );
      }
      return json(widgetRunResponse(run));
    }
    // A conversation keeps one verified identity; a changed user or role is refused, never continued.
    const previous = await deps.latestScope(scope);
    if (previous && !sameWidgetOwner(previous, scope)) {
      return json({ error: "Conversation scope changed." }, 403);
    }
    const { fresh, run } = await deps.claim(
      scope,
      requestKey(input),
      input.question
    );
    if (!fresh) {
      return json(widgetRunResponse(run));
    }
    // A claimed run is persisted pending. If session creation then fails, it
    // must be terminalized, or a retry with the same key returns it as
    // permanently pending. Use the run id as the fencing session id when no
    // session exists yet, so the terminal write is owned and settles the row.
    let sessionId: string | undefined;
    try {
      const address = widgetAddress(scope);
      const existing = resolveSession ? await resolveSession(address) : null;
      const startIndex = existing ? await existing.getStreamTailIndex() : 0;
      const session = await from(address).send(input.question, {
        auth: widgetAuth(scope),
        mode: "task",
        state: { runId: run.id },
      });
      sessionId = session.id;
      await deps.attach(run.id, session.id, startIndex);
      const settled = waitForWidgetInvestigation(session, startIndex).then(
        (outcome) => finishWidgetRun(run, session.id, outcome, deps)
      );
      waitUntil(settled.catch(() => null));
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const finished = await Promise.race([
          settled,
          new Promise<null>((resolve) => {
            timeout = setTimeout(() => resolve(null), responseWaitMs);
          }),
        ]);
        return json(widgetRunResponse(finished ?? run));
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      await deps
        .complete(
          run.id,
          blockedOutcome("session_unavailable", "failed"),
          null,
          sessionId ?? run.id
        )
        .catch(() => undefined);
      throw error;
    }
  } catch {
    logOpsEvent(
      "widget.investigation.unavailable",
      { conversationId: scope.conversationId, outcome: "error" },
      console.warn
    );
    return json({ error: "Investigation unavailable." }, 503);
  }
}

/** A session that died without completing blocks its run so the customer is not left pending. */
export async function failWidgetRun(
  runId: string | null,
  sessionId: string,
  deps: Pick<
    WidgetDependencies,
    "complete" | "read"
  > = defaultWidgetDependencies
) {
  if (!runId) {
    return;
  }
  try {
    const run = await deps.read(runId);
    if (!run.outcome) {
      await finishWidgetRun(
        run,
        sessionId,
        { status: "failed" },
        {
          complete: deps.complete,
          extract: extractWidgetFindings,
          gate: egressGate,
        }
      );
    }
  } catch {
    logOpsEvent(
      "widget.investigation.unavailable",
      { outcome: "error", runId, sessionId },
      console.warn
    );
  }
}
