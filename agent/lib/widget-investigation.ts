import { createHash } from "node:crypto";
import type { RouteHandlerArgs, Session } from "eve/channels";
import { z } from "zod";
import { readRequestBody } from "./bounded-body.js";
import { logOpsEvent } from "./ops-log.js";
import { verifyWidgetContext } from "./widget-context.js";
import {
  defaultGateDeps,
  gate as egressGate,
  type GateDeps,
  logGateDecision,
} from "./widget-egress.js";
import { resolveOwnedIdentifiers } from "./widget-evidence.js";
import { extractWidgetFindings } from "./widget-extract.js";
import { parseFindings, type WidgetFindings } from "./widget-findings.js";
import {
  answerFromHelpCenter,
  CLARIFY_PROMPT,
  EXPLAIN_PROMPT,
  KB_MISS_FALLBACK,
  KB_MISS_PROMPT,
  type KbAnswer,
  replyToChat,
} from "./widget-kb.js";
import {
  askedResult,
  handoffEligible,
  nextActionEnabled,
  validAsk,
} from "./widget-next-action.js";
import { progressFromEvents, type WidgetProgress } from "./widget-progress.js";
import {
  DECISION_CONTEXT,
  HUMAN_REQUEST_SCORE,
  logRouteDecision,
  renderAsk,
  renderConversation,
  routeWidgetMessage,
  type WidgetAsk,
  type WidgetRoute,
} from "./widget-router.js";
import {
  assertWidgetRunOwner,
  attachWidgetRun,
  claimWidgetFinish,
  claimWidgetRun,
  completeWidgetRun,
  latestWidgetScope,
  readWidgetRun,
  recentWidgetTurns,
  saveWidgetProgress,
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
      // Help-center articles a reply cited, as the web app stored them. Hints
      // only: a malformed list is dropped, never a reason to refuse the message.
      citations: z
        .array(
          z.object({ title: z.string().max(300), url: z.string().max(500) })
        )
        .max(4)
        .optional()
        .catch(undefined),
      role: z.enum(["customer", "assistant"]),
      text: z.string().max(4000),
    })
  )
  .max(12);
export type WidgetHistory = z.infer<typeof historySchema>;

/** The message as the investigator, extractor, composer and selector read it: the router's own format. */
export const withHistory = (
  question: string,
  history: WidgetHistory | undefined
): string => renderConversation(question, history);

/**
 * The message as the front door reads it: the latest message on its own, the
 * earlier turns beside it, and the articles the most recent reply cited.
 */
export const toWidgetAsk = (
  question: string,
  history: WidgetHistory | undefined
): WidgetAsk => {
  const turns = (history ?? []).filter((turn) => turn.text.trim());
  return {
    activeArticles:
      turns.filter((turn) => turn.role === "assistant").at(-1)?.citations ?? [],
    latest: question,
    turns: turns.map(({ role, text }) => ({ role, text })),
  };
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
      /** The question widget_ask_customer recorded during this turn, if a clarify decision ran. */
      asked?: string;
      findings: WidgetFindings | null;
      status: "completed";
      text: string | null;
      /** What widget_file_ticket itself returned during this turn, if it ran. */
      ticket?: NonNullable<WidgetFindings["ticket"]> | null;
    };

const TEXT_MAX = 4000;
const messageText = (data: unknown): string | null => {
  const value = (data as { message?: unknown } | null | undefined)?.message;
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed.slice(0, TEXT_MAX) : null;
};

type FiledTicket = NonNullable<WidgetFindings["ticket"]>;
const TICKET_URL =
  /^https:\/\/linear\.app\/acquisity\/issue\/(ENG-\d+)(?:[/?#]|$)/u;
const ticketOutput = z.object({ identifier: z.string(), url: z.string() });

/**
 * The ticket widget_file_ticket returned, read from the tool's own result. A
 * filed ticket is never left to the write-up: ENG-14067 was filed, the prose said
 * only "ticket filed", and the customer was told it could not be opened.
 */
export function filedTicketResult(result: unknown): FiledTicket | null {
  const action = result as {
    isError?: boolean;
    kind?: string;
    output?: unknown;
    toolName?: string;
  } | null;
  if (
    action?.kind !== "tool-result" ||
    action.isError ||
    action.toolName !== "widget_file_ticket"
  ) {
    return null;
  }
  const parsed = ticketOutput.safeParse(action.output);
  if (!parsed.success) {
    return null;
  }
  const { identifier, url } = parsed.data;
  return TICKET_URL.exec(url)?.[1] === identifier
    ? { id: identifier, url: url.slice(0, 500) }
    : null;
}

/** The tool's own result outranks whatever the write-up or the model pass said about a ticket. */
const withFiledTicket = (
  ticket: FiledTicket | null | undefined,
  findings: WidgetFindings | null
): WidgetFindings | null =>
  findings && ticket ? { ...findings, ticket } : findings;

interface Recorded {
  asked: string | null;
  ticket: FiledTicket | null;
}
/** What the turn's own tool results recorded: a filed ticket, a question for the customer. */
const recorded = (result: unknown, so: Recorded): Recorded => ({
  asked: askedResult(result) ?? so.asked,
  ticket: filedTicketResult(result) ?? so.ticket,
});
const completed = (
  asked: string | null,
  outcome: Extract<WaitOutcome, { status: "completed" }>
): WaitOutcome => (asked ? { ...outcome, asked } : outcome);

/**
 * Task completion owns the answer. The structured result is the findings
 * channel; the last assistant message is kept as a fallback so a finish that
 * narrated instead of returning the schema still hands the teammate real prose.
 */
export async function waitForWidgetInvestigation(
  session: Pick<Session, "getEventStream">,
  startIndex = 0,
  timeoutMs = 120_000,
  onProgress?: (progress: WidgetProgress) => Promise<void>
): Promise<WaitOutcome> {
  const reader = (await session.getEventStream({ startIndex })).getReader();
  const timeout = setTimeout(
    () => reader.cancel().catch(() => undefined),
    timeoutMs
  );
  const progress = progressFromEvents();
  let findings: WidgetFindings | null = null;
  let text: string | null = null;
  let ticket: FiledTicket | null = null;
  let asked: string | null = null;
  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: preserve durable stream order.
      const { done, value: event } = await reader.read();
      if (done) {
        return { status: "pending" };
      }
      const update = progress(event);
      if (update) {
        await onProgress?.(update).catch(() => undefined);
      }
      if (event.type === "turn.started") {
        findings = null;
        text = null;
        ticket = null;
        asked = null;
      } else if (event.type === "action.result") {
        ({ asked, ticket } = recorded(event.data.result, { asked, ticket }));
      } else if (event.type === "result.completed") {
        findings = parseFindings(event.data.result);
      } else if (event.type === "message.completed") {
        text = messageText(event.data) ?? text;
      } else if (event.type === "session.completed") {
        return completed(asked, {
          findings,
          status: "completed",
          text,
          ticket,
        });
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
  handoffEligible,
  history: recentWidgetTurns,
  latestScope: latestWidgetScope,
  progress: saveWidgetProgress,
  read: readWidgetRun,
  route: routeWidgetMessage,
  /** Throws unless the scoped user is a current owner or admin of the scoped workspace. */
  verifyAccess: (scope: WidgetContext) =>
    resolveOwnedIdentifiers(scope, { emails: [], slugs: [], uuids: [] }),
};
export type WidgetDependencies = Omit<
  typeof defaultWidgetDependencies,
  "progress"
> &
  Partial<Pick<typeof defaultWidgetDependencies, "progress">>;

const disclose = (outcome: WidgetOutcome, findings: unknown) =>
  outcome.decision === "block" || Boolean(findings);

/**
 * Every investigation returns its findings, answered or blocked, so the CS
 * inbox always has a team-only note for it. They go server to server and are
 * never shown to the customer; only the gated, composed `message` is. The
 * help-center and small-talk lanes have no findings to return.
 */
// A block from our own controls (the deadline, the ownership guard, a gate
// outage) is not a finding that needs a person: the app tells the customer to
// send the message again instead of promising a teammate. The reason itself can
// name an identifier, so only this flag crosses to the app.
const RETRYABLE_BLOCK =
  /^(?:deadline$|gate_unavailable$|explain_unavailable$|(?:composed:)?(?:foreign_identifier|internal_artifact):)/u;

export function widgetRunResponse(run: WidgetRun) {
  if (!run.outcome) {
    return {
      run_id: run.id,
      status: "pending" as const,
      ...(run.progress ? { progress: run.progress } : {}),
    };
  }
  return {
    decision: run.outcome.decision,
    ...(run.outcome.decision === "block" &&
    RETRYABLE_BLOCK.test(run.outcome.reason ?? "")
      ? { retry: true as const }
      : {}),
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
 * The Acquisity app stops polling 285s after it sends (its route lives 300s), and finishing a
 * settled investigation (extract, gate, compose) has taken up to ~100s. Deadline plus finish
 * must land inside that window, or the answer completes after the last poll and is never delivered.
 */
export const WIDGET_DEADLINE_MS = 170_000;
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
 * How sure the router must be of `kb` before a help-center miss is answered
 * with a clarifying question instead of an investigation. Below it the router
 * was unsure the message is general, so an account lookup stays possible.
 */
const STRONG_KB_CONFIDENCE = 0.6;
/**
 * Below this, an `investigate` pick gives the help center a guarded first try
 * (`WidgetAsk.accountLikely`): it answers only what an article fully resolves,
 * asks what a fragment means, and otherwise steps aside for the investigation.
 * Scores alone cannot make this call. Documented how-tos were picked
 * `investigate` anywhere from 0.51 to 0.84 ("Google says the app is blocked when
 * I connect Email and Calendar": 0.61 in one thread, 0.84 on a fresh one), and
 * real account questions from 0.72 up. The try costs a few seconds, so only the
 * picks the router is sure of (0.91 to 1.00 in the same runs) skip it.
 */
const SURE_INVESTIGATE_CONFIDENCE = 0.9;
/** How sure the router must be that the message only continues the previous reply. */
const FOLLOW_UP_SCORE = 0.6;
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
 * How sure the router must be that the customer only asks what the previous
 * reply meant. High on purpose: a request for fresh evidence must still be investigated.
 */
const EXPLAIN_SCORE = 0.8;
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

/**
 * Preview pilot: a person is asked for only when the customer asked for one or
 * billing needs reconciling. Acquisity hands off on needsHuman alone, so findings
 * that ask for a person on other grounds (an unavailable source, conflicting or
 * old records) keep every fact and caveat and go to the customer as an answer.
 * Only this flag changes: the ownership scan, the reviewer and every block still
 * run on what is left. If eligibility cannot be checked the findings stand.
 */
async function withEligibleHandoff(
  findings: WidgetFindings | null,
  conversation: string,
  ids: { conversationId: string; runId: string; sessionId: string },
  check: WidgetDependencies["handoffEligible"] | undefined
): Promise<WidgetFindings | null> {
  if (!(findings?.needsHuman && check && nextActionEnabled())) {
    return findings;
  }
  const startedAt = Date.now();
  const log = (decision: string) =>
    logOpsEvent("widget.handoff.eligibility", {
      ...ids,
      decision,
      message: `ms=${Date.now() - startedAt}`,
    });
  try {
    const eligible = await check({ conversation, findings });
    log(eligible ? "kept" : "cleared");
    return eligible ? findings : { ...findings, needsHuman: false };
  } catch {
    log("fallback");
    return findings;
  }
}

/**
 * A post-tool clarify decision is answered with one question. That question is
 * the whole reply, so it skips the two slow model passes that only exist to turn
 * a report into a reply (structuring it, then composing from it). It still goes
 * through the ownership scan, the reviewer and the final text scan.
 */
const askedFindings = (asked: string) =>
  parseFindings({
    confidence: "low",
    facts: [],
    needsHuman: false,
    recommendation: asked,
    report: `Asked the customer: ${asked}`.slice(0, 1000),
  });

const survivingQuestion: GateDeps["compose"] = ({ findings }) => {
  // The same contract the question was recorded under, applied to what is left.
  return Promise.resolve(validAsk(findings.recommendation) ?? "");
};

/** A lone clarify question as it stands; otherwise the write-up structured by a model pass, then held to handoff eligibility. */
async function structureWriteUp(
  run: Pick<WidgetRun, "id" | "scope">,
  sessionId: string,
  outcome: Extract<WaitOutcome, { status: "completed" }>,
  conversation: string,
  deps: Pick<WidgetDependencies, "extract"> &
    Partial<Pick<WidgetDependencies, "handoffEligible">>
) {
  const asked = nextActionEnabled() ? outcome.asked : null;
  if (asked) {
    return {
      // What is delivered is what the reviewer left, never the text as written:
      // "Buy another domain. Which campaign do you mean?" with the first sentence
      // deleted must not come back whole. If no question survives, nothing is sent.
      gateDeps: {
        ...defaultGateDeps,
        compose: survivingQuestion,
      },
      structured: askedFindings(asked),
    };
  }
  const extracted =
    outcome.findings ??
    (outcome.text
      ? await deps.extract({
          investigatorText: outcome.text,
          question: conversation,
          scope: run.scope,
        })
      : null);
  return {
    gateDeps: undefined,
    structured: await withEligibleHandoff(
      withFiledTicket(outcome.ticket, extracted),
      conversation,
      { conversationId: run.scope.conversationId, runId: run.id, sessionId },
      deps.handoffEligible
    ),
  };
}

/** Gate, then persist. Runs once per session outcome; a replay finds the fenced row unchanged. */
export async function finishWidgetRun(
  run: Pick<WidgetRun, "created_at" | "id" | "question" | "scope">,
  sessionId: string,
  outcome: WaitOutcome,
  deps: Pick<
    WidgetDependencies,
    "claimFinish" | "complete" | "extract" | "gate" | "history"
  > &
    Partial<Pick<WidgetDependencies, "handoffEligible" | "progress">>
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
  if (outcome.status === "completed") {
    await deps
      .progress?.(run.id, sessionId, {
        checks: [],
        sequence: 0,
        stage: "preparing",
      })
      .catch(() => undefined);
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
    const { gateDeps, structured } = await structureWriteUp(
      run,
      sessionId,
      outcome,
      conversation,
      deps
    );
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
        gateDeps,
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
    responseWaitMs,
    deps.progress
      ? (progress) =>
          deps.progress?.(run.id, sessionId, progress) ?? Promise.resolve()
      : undefined
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

/** The reply to a confident help-center question nothing answered: a question back, never blank. */
async function kbMissReply(
  run: WidgetRun,
  ask: WidgetAsk,
  deps: Pick<WidgetDependencies, "answerChat" | "complete">
): Promise<WidgetRun | null> {
  const reply = await deps
    .answerChat(
      renderAsk(ask),
      { conversationId: run.scope.conversationId, runId: run.id },
      KB_MISS_PROMPT
    )
    .catch(() => null);
  return deps.complete(
    run.id,
    {
      citations: [],
      decision: "allow",
      message: reply?.message || KB_MISS_FALLBACK,
      reason: "kb_miss",
      status: "completed",
    },
    null,
    run.id
  );
}

/** One clarifying question; null when it cannot be written, so the caller falls through. */
async function clarifyReply(
  run: WidgetRun,
  ask: WidgetAsk,
  deps: Pick<WidgetDependencies, "answerChat" | "complete">
): Promise<WidgetRun | null> {
  const reply = await deps
    .answerChat(
      renderAsk(ask),
      { conversationId: run.scope.conversationId, runId: run.id },
      CLARIFY_PROMPT
    )
    .catch(() => null);
  return reply
    ? deps.complete(
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
      )
    : null;
}

const EXPLAIN_ATTEMPTS = 2;

/**
 * Explain the previous reply from its own words. Three outcomes, kept apart:
 * answered; the writer returned nothing because the message needs something the
 * earlier turns do not hold, which is the only one that goes on to an
 * investigation (null); and the writer failing technically. Run 02be7213 timed
 * out at 12s, fell through, and cost the customer a 135s investigation of a
 * question that needed none. A timeout says nothing about the question, so it is
 * tried once more and then the customer is asked to send the message again.
 */
async function explainPrevious(
  run: WidgetRun,
  ask: WidgetAsk,
  ids: { conversationId: string; runId: string },
  deps: Pick<WidgetDependencies, "answerChat" | "complete">
): Promise<WidgetRun | null> {
  const log = (decision: string, attempts: number) =>
    logOpsEvent("widget.explain", {
      ...ids,
      decision,
      message: `attempts=${attempts}`,
    });
  for (let attempt = 1; attempt <= EXPLAIN_ATTEMPTS; attempt += 1) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: the second try only follows a failed first.
      const reply = await deps.answerChat(
        renderAsk(ask, DECISION_CONTEXT),
        ids,
        EXPLAIN_PROMPT,
        true
      );
      log(reply ? "answered" : "needs_lookup", attempt);
      return reply
        ? deps.complete(
            run.id,
            {
              citations: [],
              decision: "allow",
              message: reply.message,
              reason: "explain",
              status: "completed",
            },
            null,
            run.id
          )
        : null;
    } catch {
      // Tried again below, or reported once the attempts run out.
    }
  }
  log("unavailable", EXPLAIN_ATTEMPTS);
  return deps.complete(
    run.id,
    blockedOutcome("explain_unavailable", "completed"),
    null,
    run.id
  );
}

/**
 * Front door: an ask for a person hands off at once, and a general product
 * question is answered from the help center, both without starting an
 * investigation. Returns null for every other route, a router failure (which
 * falls open to `investigate`), and a miss on a message the router was not sure
 * is general, so those take the investigation lane. A miss on a confident
 * help-center question is answered with a clarifying question instead: it never
 * needed account data, so it never gets an investigation or a handoff.
 */
async function answerFromKnowledgeBase(
  run: WidgetRun,
  scope: WidgetContext,
  ask: WidgetAsk,
  signal: AbortSignal,
  deps: WidgetDependencies
): Promise<WidgetRun | null> {
  const route = await deps.route(ask, { signal });
  // Every reply written at the front door reads the latest message first with
  // a few bounded turns; the full transcript is for a real investigation only.
  const question = renderAsk(ask);
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
  if (route.asksForHuman >= HUMAN_REQUEST_SCORE) {
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
  // "Does that mean none happened, or none were recorded?" is answered by the
  // reply it asks about. It took a 22s help-center miss and then a second full
  // investigation. The writer sees the whole previous reply, may add nothing to
  // it, and returns nothing when the message needs a look, which falls through.
  if (
    route.lane !== "human" &&
    (route.explainsPrevious ?? 0) >= EXPLAIN_SCORE &&
    ask.turns?.some((turn) => turn.role === "assistant")
  ) {
    const explained = await explainPrevious(run, ask, ids, deps);
    if (explained) {
      return explained;
    }
  }
  // Nothing to look up yet: ask what they mean instead of spending minutes on
  // a broad account investigation. If that reply cannot be written, fall through.
  if (route.lane !== "human" && (route.unclear ?? 0) >= UNCLEAR_SCORE) {
    const reply = await clarifyReply(run, ask, deps);
    if (reply) {
      return reply;
    }
  }
  return answerGeneralQuestion(run, route, ask, finish, deps);
}

/** The help-center try, for a general question or a request to act; null sends the message on to an investigation. */
async function answerGeneralQuestion(
  run: WidgetRun,
  route: WidgetRoute,
  ask: WidgetAsk,
  finish: (written: KbAnswer) => Promise<WidgetRun | null>,
  deps: WidgetDependencies
): Promise<WidgetRun | null> {
  // An explicit ask for a person is never overridden by a help-center guess.
  const closeSecond = route.lane !== "human" && route.kbScore >= KB_SCORE;
  // A ticket can only be filed from an investigation, so it never detours here.
  const guardedTry =
    route.lane === "investigate" &&
    route.source === "jev" &&
    !route.ticket &&
    !closeSecond &&
    route.confidence < SURE_INVESTIGATE_CONFIDENCE;
  const generalQuestion = route.lane === "kb" || closeSecond || guardedTry;
  // A request to act never needs an investigation: the fast lane apologises and
  // gives the steps. An explicit ask for a person is left alone.
  const actionRequest =
    route.lane !== "human" && route.asksForAction >= ACTION_REQUEST_SCORE;
  if (!(generalQuestion || actionRequest)) {
    return null;
  }
  const answer = await deps.answerKb(
    {
      ...ask,
      accountLikely: guardedTry,
      followUp: (route.followUp ?? 0) >= FOLLOW_UP_SCORE,
    },
    { conversationId: run.scope.conversationId, runId: run.id }
  );
  if (answer?.unclear) {
    // If the question cannot be written, the investigation runs as it always did.
    return clarifyReply(run, ask, deps);
  }
  if (answer) {
    return finish(answer);
  }
  const strongKb =
    actionRequest ||
    (route.lane === "kb" && route.confidence >= STRONG_KB_CONFIDENCE);
  return strongKb ? kbMissReply(run, ask, deps) : null;
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
    await deps
      .progress?.(run.id, session.id, {
        checks: [],
        sequence: 0,
        stage: "investigating",
      })
      .catch(() => undefined);
    const settled = waitForWidgetInvestigation(
      session,
      startIndex,
      120_000,
      deps.progress
        ? (progress) =>
            deps.progress?.(run.id, session.id, progress) ?? Promise.resolve()
        : undefined
    ).then((outcome) => finishWidgetRun(run, session.id, outcome, deps));
    waitUntil(settled.catch(() => null));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const finished = await Promise.race([
        settled,
        new Promise<null>((resolve) => {
          timeout = setTimeout(
            () => resolve(null),
            Math.min(responseWaitMs, 1000)
          );
        }),
      ]);
      return finished ?? (await deps.read(run.id));
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

async function pollWidgetRun(
  run: WidgetRun,
  attach: NonNullable<RouteHandlerArgs["attachSession"]>,
  waitMs: number,
  deps: WidgetDependencies,
  waitUntil: RouteHandlerArgs["waitUntil"]
): Promise<WidgetRun> {
  if (!run.session_id) {
    return run;
  }
  const settling = settleResultRun(run, run.session_id, attach, waitMs, deps);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const finished = await Promise.race([
      settling,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), waitMs + 25);
      }),
    ]);
    if (!finished) {
      waitUntil(settling.catch(() => run));
    }
    return finished ?? (await deps.read(run.id));
  } finally {
    clearTimeout(timer);
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
        run = await pollWidgetRun(
          run,
          attachSession,
          Math.min(responseWaitMs, 1000),
          deps,
          waitUntil
        );
      }
      return json(widgetRunResponse(run));
    }
    // A conversation keeps one verified identity; a changed user or role is refused, never continued.
    const previous = await deps.latestScope(scope);
    if (previous && !sameWidgetOwner(previous, scope)) {
      return json({ error: "Conversation scope changed." }, 403);
    }
    const { busy, fresh, run } = await deps.claim(
      scope,
      requestKey(input),
      input.question
    );
    if (busy) {
      return json({ run_id: run.id, status: "busy" });
    }
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
          toWidgetAsk(input.question, input.history),
          request.signal,
          deps
        );
    if (answered) {
      return json(widgetRunResponse(answered));
    }
    // The app vouches for the scope, but a preview admin override names a user
    // the app cannot check. Re-check membership where the tools read, so a
    // mismatched pair is refused here, not one denied tool call at a time.
    try {
      await deps.verifyAccess(scope);
    } catch {
      await deps
        .complete(
          run.id,
          blockedOutcome("workspace_access_denied", "failed"),
          null,
          run.id
        )
        .catch(() => undefined);
      return json({ error: "Workspace could not be verified." }, 403);
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
