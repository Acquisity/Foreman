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
  answerFromHelpCenter,
  CLARIFY_PROMPT,
  type KbAnswer,
  replyToChat,
} from "./widget-kb.js";
import { logRouteDecision, routeWidgetMessage } from "./widget-router.js";
import {
  assertWidgetRunOwner,
  attachWidgetRun,
  claimWidgetFinish,
  claimWidgetRun,
  completeWidgetRun,
  latestWidgetScope,
  readWidgetRun,
  recentWidgetTurns,
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
  // A support teammate started this from the inbox. It always investigates,
  // and the caller keeps the result team-only.
  staff: z.boolean().optional(),
};
/**
 * Recent customer-visible turns of the same conversation, oldest first. The
 * fast lane answers without a session, so without this a follow-up such as
 * "where is that?" reaches the router, the fast lane and the investigator with
 * nothing to resolve "that" against.
 */
const historySchema = z
  .array(
    z.strictObject({
      role: z.enum(["customer", "assistant"]),
      text: z.string().max(4000),
    })
  )
  .max(12);
export type WidgetHistory = z.infer<typeof historySchema>;

const HISTORY_TURN_CHARS = 1200;

/** The message as each lane should read it: the earlier turns as context, then the question. */
export const withHistory = (
  question: string,
  history: WidgetHistory | undefined
): string => {
  const turns = (history ?? []).filter((turn) => turn.text.trim());
  if (turns.length === 0) {
    return question;
  }
  const transcript = turns
    .map(
      (turn) =>
        `${turn.role === "customer" ? "Customer" : "Support"}: ${turn.text.trim().slice(0, HISTORY_TURN_CHARS)}`
    )
    .join("\n");
  return `Earlier in this conversation:\n${transcript}\n\nThe customer's latest message, which is the one to answer:\n${question}`;
};

const inputSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...scopeFields,
    action: z.literal("start"),
    history: historySchema.optional(),
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

/** Inbox runs get their own session, so a teammate's instruction never sits in the customer's. */
export const widgetAddress = (scope: {
  organizationId: string;
  conversationId: string;
  source?: "widget" | "inbox";
}) =>
  `${scope.organizationId}:${scope.conversationId}${scope.source === "inbox" ? ":inbox" : ""}`;

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
  answerChat: replyToChat,
  answerKb: answerFromHelpCenter,
  attach: attachWidgetRun,
  claim: claimWidgetRun,
  claimFinish: claimWidgetFinish,
  complete: completeWidgetRun,
  extract: extractWidgetFindings,
  gate: egressGate,
  history: recentWidgetTurns,
  latestScope: latestWidgetScope,
  read: readWidgetRun,
  route: routeWidgetMessage,
};
export type WidgetDependencies = typeof defaultWidgetDependencies;

const disclose = (outcome: WidgetOutcome, findings: unknown) =>
  outcome.decision === "block" || Boolean(findings);

/**
 * Every investigation returns its findings, answered or blocked, so the CS
 * inbox always has a team-only note for it. They go server to server and are
 * never shown to the customer; only the gated, composed `message` is. The
 * help-center and small-talk lanes have no findings to return.
 */
export function widgetRunResponse(run: WidgetRun) {
  if (!run.outcome) {
    return { run_id: run.id, status: "pending" as const };
  }
  return {
    decision: run.outcome.decision,
    message: run.outcome.message,
    run_id: run.id,
    status: run.outcome.status,
    ...(run.outcome.citations?.length
      ? { citations: run.outcome.citations }
      : {}),
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
/** How sure the router must be that a message is small talk before it gets a one-line reply. */
const CHAT_ROUTE_CONFIDENCE = 0.6;
/**
 * How likely the help center must be before the fast lane gets the first try
 * when another lane won. When `kb` is the router's pick it always gets the
 * first try, however unsure.
 *
 * The two mistakes are not equal. A wrongly fast-laned message costs a few
 * seconds and a follow-up ("can you check my actual data?"). A wrongly
 * investigated how-to costs the customer minutes and an answer about account
 * details they never asked for: "what is my dashboard for?" won `kb` at 0.54,
 * and "when do my credits reset" at 0.39, and both were investigated under the
 * old 0.6 bar. A real account question scores near zero here.
 */
const KB_SCORE = 0.5;
/**
 * How sure the router must be that the customer wants something done for them.
 * High on purpose: a lookup wrongly read as a request to act would get general
 * steps instead of a look at the account.
 */
const ACTION_REQUEST_SCORE = 0.8;
/**
 * How sure the router must be that nobody could help without first asking what
 * the customer means. High on purpose: a wrongly asked question costs one turn,
 * but it must not get in the way of a real, answerable account question.
 */
const UNCLEAR_SCORE = 0.8;
/**
 * How sure the router must be that the customer asked for a person before the
 * run hands off without investigating. High on purpose: a wrong handoff costs a
 * teammate's time on something Foreman could have answered.
 */
const HUMAN_REQUEST_SCORE = 0.8;
const HUMAN_REQUEST_NOTE =
  "The customer asked to speak with a person. Nothing was investigated for this message.";
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
  run: Pick<WidgetRun, "created_at" | "id" | "question" | "scope">,
  sessionId: string,
  outcome: WaitOutcome,
  deps: Pick<
    WidgetDependencies,
    "claimFinish" | "complete" | "extract" | "gate" | "history"
  >
): Promise<WidgetRun | null> {
  if (outcome.status === "pending") {
    return null;
  }
  // Someone else is already finishing this run: report pending and let the next
  // poll read what they save. Only the model work is worth claiming; a failed
  // session is recorded at once. A claim that cannot be checked never costs the
  // customer their reply, so it falls open to finishing twice as before.
  if (
    outcome.status === "completed" &&
    !(await deps.claimFinish(run.id).catch(() => true))
  ) {
    return null;
  }
  let result: WidgetOutcome;
  let findings: unknown = null;
  if (outcome.status === "failed") {
    result = blockedOutcome("session_failed", "failed");
  } else {
    // The investigator writes prose; a separate pass structures it. Any leftover
    // stream-carried findings still work, but the schema no longer fails the session.
    // The extractor and the composer read the latest message in its
    // conversation, so a reply continues the thread instead of starting over.
    // A failed read costs only that context, never the reply. The judge still
    // gets the question alone: it rules on the findings, not the conversation.
    const conversation = withHistory(
      run.question,
      await deps.history(run).catch(() => [])
    );
    const extractStartedAt = Date.now();
    const structured =
      outcome.findings ??
      (outcome.text
        ? await deps.extract({
            investigatorText: outcome.text,
            question: conversation,
            scope: run.scope,
          })
        : null);
    const extractMs = Date.now() - extractStartedAt;
    const handoff = structured
      ? null
      : (outcome.text &&
          humanHandoff(outcome.text, "no_structured_findings")) ||
        null;
    if (structured) {
      findings = structured;
      const gated = await deps.gate(
        run.scope,
        run.question,
        structured,
        undefined,
        conversation
      );
      // Where the wait after an investigation goes: three model calls in a row.
      // Decision and reason ride along because log search surfaces one line per
      // request, and this line would otherwise hide why a reply was blocked.
      logOpsEvent("widget.finish.timing", {
        conversationId: run.scope.conversationId,
        decision: gated.decision,
        message: [
          `extract=${extractMs}`,
          ...Object.entries(gated.timings ?? {}).map(
            ([step, ms]) => `${step}=${ms}`
          ),
          `| ${gated.reason}`,
        ].join(" "),
        runId: run.id,
        sessionId,
      });
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
    .update(
      JSON.stringify([
        input.conversation_id,
        input.question,
        ...(input.staff ? ["inbox"] : []),
      ])
    )
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

/**
 * Front door: an ask for a person hands off at once, and a general product
 * question is answered from the help center, both without starting an
 * investigation. Returns null for every other route,
 * a router failure (which falls open to `investigate`), and any knowledge-base
 * miss, so those take the investigation lane exactly as before.
 */
async function answerFromKnowledgeBase(
  run: WidgetRun,
  scope: WidgetContext,
  question: string,
  signal: AbortSignal,
  deps: WidgetDependencies
): Promise<WidgetRun | null> {
  const route = await deps.route(question, { signal });
  logRouteDecision(
    { conversationId: scope.conversationId, runId: run.id },
    route
  );
  const ids = { conversationId: scope.conversationId, runId: run.id };
  const finish = (written: KbAnswer) =>
    deps.complete(
      run.id,
      {
        citations: written.citations,
        decision: "allow",
        message: written.message,
        reason: route.lane === "chat" ? "chat" : "kb",
        status: "completed",
      },
      null,
      // No session exists on this lane, so the run id is the fencing session id.
      run.id
    );
  // An explicit ask for a person is honoured at once: no investigation stands
  // between the customer and the handoff. The note tells the teammate why.
  if (route.lane === "human" || route.asksForHuman >= HUMAN_REQUEST_SCORE) {
    const handoff = humanHandoff(HUMAN_REQUEST_NOTE, "asked_for_human");
    if (handoff) {
      return deps.complete(run.id, handoff.result, handoff.findings, run.id);
    }
  }
  // A thank you or a reaction gets a sentence back, not an investigation. If
  // that reply cannot be written the message falls through as it always did.
  if (route.lane === "chat" && route.confidence >= CHAT_ROUTE_CONFIDENCE) {
    const reply = await deps.answerChat(question, ids);
    if (reply) {
      return finish(reply);
    }
  }
  // Nothing to look up yet: ask what they mean instead of spending minutes on
  // a broad account investigation. If that reply cannot be written, fall through.
  if (route.lane !== "human" && (route.unclear ?? 0) >= UNCLEAR_SCORE) {
    const reply = await deps.answerChat(question, ids, CLARIFY_PROMPT);
    if (reply) {
      return deps.complete(
        run.id,
        {
          citations: [],
          decision: "allow",
          message: reply.message,
          reason: "clarify",
          status: "completed",
        },
        null,
        run.id
      );
    }
  }
  // An explicit ask for a person is never overridden by a help-center guess.
  const generalQuestion =
    route.lane === "kb" ||
    (route.lane !== "human" && route.kbScore >= KB_SCORE);
  // A request to act never needs an investigation: the fast lane apologises and
  // gives the steps. An explicit ask for a person is left alone.
  const actionRequest =
    route.lane !== "human" && route.asksForAction >= ACTION_REQUEST_SCORE;
  if (!(generalQuestion || actionRequest)) {
    return null;
  }
  const answer = await deps.answerKb(question, ids);
  return answer ? finish(answer) : null;
}

/**
 * Start the investigator session for a claimed run and wait briefly for a fast
 * finish; the rest settles in the background and is read by the result poll.
 *
 * A claimed run is persisted pending. If session creation then fails, it must
 * be terminalized, or a retry with the same key returns it as permanently
 * pending. Use the run id as the fencing session id when no session exists yet,
 * so the terminal write is owned and settles the row.
 */
async function startInvestigation(
  run: WidgetRun,
  scope: WidgetContext,
  question: string,
  {
    from,
    resolveSession,
    waitUntil,
  }: Pick<RouteHandlerArgs<{ runId: string | null }>, "from" | "waitUntil"> &
    Partial<Pick<RouteHandlerArgs, "resolveSession">>,
  responseWaitMs: number,
  deps: WidgetDependencies
): Promise<WidgetRun> {
  let sessionId: string | undefined;
  try {
    const address = widgetAddress(scope);
    const existing = resolveSession ? await resolveSession(address) : null;
    const startIndex = existing ? await existing.getStreamTailIndex() : 0;
    const session = await from(address).send(question, {
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
      return finished ?? run;
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
      staff: input.staff,
      userToken,
    });
  } catch {
    return json({ error: "Workspace could not be verified." }, 403);
  }
  try {
    if (input.action === "result") {
      let run = await deps.read(input.run_id);
      assertWidgetRunOwner(run, scope);
      // A teammate's run is read only through the teammate's verified path.
      if (run.scope.source !== scope.source) {
        throw new Error("Investigation unavailable for this conversation.");
      }
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
    const message = withHistory(input.question, input.history);
    // A teammate asked for an investigation: no help-center or handoff front door.
    const answered = input.staff
      ? null
      : await answerFromKnowledgeBase(
          run,
          scope,
          message,
          request.signal,
          deps
        );
    if (answered) {
      return json(widgetRunResponse(answered));
    }
    return json(
      widgetRunResponse(
        await startInvestigation(
          run,
          scope,
          message,
          { from, resolveSession, waitUntil },
          responseWaitMs,
          deps
        )
      )
    );
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
          claimFinish: claimWidgetFinish,
          complete: deps.complete,
          extract: extractWidgetFindings,
          gate: egressGate,
          history: recentWidgetTurns,
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
