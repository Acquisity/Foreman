import type { RouteHandlerArgs, Session } from "eve/channels";
import { z } from "zod";
import { readRequestBody } from "./bounded-body.js";
import { logOpsEvent } from "./ops-log.js";
import { answerFromGuide, chatGuideEnabled } from "./widget-chat.js";
import { verifyWidgetContext } from "./widget-context.js";
import {
  defaultGateDeps,
  gate as egressGate,
  type GateDeps,
  logGateDecision,
} from "./widget-egress.js";
import {
  resolveOwnedIdentifiers,
  WorkspaceAccessDenied,
} from "./widget-evidence.js";
import { extractWidgetFindings } from "./widget-extract.js";
import { parseFindings, type WidgetFindings } from "./widget-findings.js";
import { answerFromHelpCenter, type KbAnswer } from "./widget-kb.js";
import {
  askedResult,
  handoffEligible,
  nextActionEnabled,
  validAsk,
} from "./widget-next-action.js";
import {
  type CheckId,
  planWidgetChecks,
  progressFromEvents,
  type WidgetProgress,
} from "./widget-progress.js";
import {
  asksForChange,
  DECISION_CONTEXT,
  HUMAN_REQUEST_SCORE,
  logRouteDecision,
  offersRecording,
  renderConversation,
  routeWidgetMessage,
  type WidgetAsk,
  type WidgetRoute,
} from "./widget-router.js";
import {
  assertWidgetRunOwner,
  attachWidgetRun,
  cancelWidgetRun,
  claimWidgetFinish,
  claimWidgetRun,
  completeWidgetRun,
  expireSessionlessWidgetRun,
  expireSessionlessWidgetRuns,
  FINISH_CLAIM_SECONDS,
  latestWidgetScope,
  readWidgetRun,
  recentInboxTurns,
  recentWidgetTurns,
  requestWidgetRecording,
  saveWidgetProgress,
  type WidgetOutcome,
  type WidgetRun,
} from "./widget-run-store.js";
import {
  sameWidgetOwner,
  type WidgetContext,
  widgetAuth,
} from "./widget-scope.js";
import { serviceSecretRefusal } from "./widget-service-secret.js";

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
  history: WidgetHistory | undefined,
  screenshots?: string[]
): string =>
  renderConversation(question, history, DECISION_CONTEXT, screenshots);

/** A teammate's message with the earlier team-only exchange on this conversation after it. */
export const withTeamThread = (
  message: string,
  turns: { role: "teammate" | "foreman"; text: string }[]
): string =>
  turns.length
    ? `${message}\n\nEARLIER TEAM-ONLY CONVERSATION (a support teammate and Foreman discussed this customer conversation before this message; the customer never saw it. Build on it when the latest message follows up, and recheck anything that may have changed since):\n${turns
        .map(
          (turn) =>
            `${turn.role === "teammate" ? "Teammate" : "Foreman"}: ${turn.text}`
        )
        .join("\n")}`
    : message;

/**
 * The message as the front door reads it: the latest message on its own, the
 * earlier turns beside it, and the articles the most recent reply cited.
 */
export const toWidgetAsk = (
  question: string,
  history: WidgetHistory | undefined,
  screenshots?: string[],
  images?: string[]
): WidgetAsk => {
  const turns = (history ?? []).filter((turn) => turn.text.trim());
  return {
    activeArticles:
      turns.filter((turn) => turn.role === "assistant").at(-1)?.citations ?? [],
    ...(images?.length ? { images } : {}),
    latest: question,
    ...(screenshots?.length ? { screenshots } : {}),
    turns: turns.map(({ role, text }) => ({ role, text })),
  };
};

const MAX_IMAGE_URL_CHARS = 2048;

const inputSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...scopeFields,
    action: z.literal("start"),
    history: historySchema.optional(),
    // Short-lived links to the same screenshots, for the help-center lane to
    // look at. The readings stay: every other stage reads only text.
    images: z
      .array(z.url({ protocol: /^https$/u }).max(MAX_IMAGE_URL_CHARS))
      .max(3)
      .optional(),
    message_id: z.uuid(),
    // The customer's explicit "Investigate my workspace" toggle.
    mode: z.literal("investigate").optional(),
    question: z.string().trim().min(1).max(4000),
    // The screen recording this turn follows up on, which the investigator
    // reads through widget_read_recording.
    recording: z
      .strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/) })
      .optional(),
    // What /internal/widget/image read from each screenshot sent with this
    // message. The front door and the investigator read them beside the
    // question; the stored run keeps them joined onto it for later stages.
    screenshots: z.array(z.string().trim().min(1).max(1500)).max(3).optional(),
  }),
  z.strictObject({
    ...scopeFields,
    action: z.literal("result"),
    run_id: z.uuid(),
  }),
  z.strictObject({
    ...scopeFields,
    action: z.literal("cancel"),
    run_id: z.uuid(),
  }),
]);
export type WidgetInput = z.infer<typeof inputSchema>;

/**
 * The largest body a valid start can be: the question, twelve turns with four
 * citations each, three screenshot readings and three image links at their schema limits, every
 * character escaped to six in JSON (\u0000), plus room for the ids and keys.
 * The default 8 KB read cap refused ordinary multi-turn conversations.
 */
const MAX_START_BODY_CHARS =
  (4000 + 12 * (4000 + 4 * (300 + 500)) + 3 * 1500 + 3 * MAX_IMAGE_URL_CHARS) *
    6 +
  4096;

/** The question as the run stores it, readings and all, for the stages that read it back. */
export const withScreenshots = (
  input: Extract<WidgetInput, { action: "start" }>
): string => [input.question, ...(input.screenshots ?? [])].join("\n\n");

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
      ticket?: FiledTicket | null;
    };

const TEXT_MAX = 4000;
const messageText = (data: unknown): string | null => {
  const value = (data as { message?: unknown } | null | undefined)?.message;
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed.slice(0, TEXT_MAX) : null;
};

/** `refund` is ours alone: the findings contract carries only the id and url. */
type FiledTicket = NonNullable<WidgetFindings["ticket"]> & { refund?: true };
const TICKET_URL =
  /^https:\/\/linear\.app\/acquisity\/issue\/(ENG-\d+)(?:[/?#]|$)/u;
const ticketOutput = z.object({
  identifier: z.string(),
  refund: z.boolean().optional(),
  url: z.string(),
});

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
  const { identifier, refund, url } = parsed.data;
  return TICKET_URL.exec(url)?.[1] === identifier
    ? { id: identifier, url: url.slice(0, 500), ...(refund ? { refund } : {}) }
    : null;
}

/**
 * The tool's own result outranks whatever the write-up or the model pass said
 * about a ticket: with no filed ticket, a claimed one is dropped so the customer
 * is never told one was filed. A filed refund ticket is the handoff to billing,
 * so the customer gets a reply saying so instead of a handoff to a person.
 */
const withFiledTicket = (
  ticket: FiledTicket | null | undefined,
  findings: WidgetFindings | null
): WidgetFindings | null => {
  if (!findings) {
    return findings;
  }
  if (!ticket) {
    const { ticket: _claimed, ...unfiled } = findings;
    return unfiled;
  }
  const { refund, ...filed } = ticket;
  return {
    ...findings,
    ...(refund ? { needsHuman: false } : {}),
    ticket: filed,
  };
};

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
  onProgress?: (progress: WidgetProgress) => Promise<void>,
  planned: readonly CheckId[] = []
): Promise<WaitOutcome> {
  const reader = (await session.getEventStream({ startIndex })).getReader();
  const timeout = setTimeout(
    () => reader.cancel().catch(() => undefined),
    timeoutMs
  );
  const progress = progressFromEvents(planned);
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
  /** The front-door chat: the guide lane unless WIDGET_CHAT=legacy, then the help-center writer. */
  answerChat: chatGuideEnabled() ? answerFromGuide : undefined,
  answerKb: answerFromHelpCenter,
  attach: attachWidgetRun,
  cancel: cancelWidgetRun,
  changeRequested: (conversation: string) => asksForChange(conversation),
  claim: claimWidgetRun,
  claimFinish: claimWidgetFinish,
  complete: completeWidgetRun,
  expire: expireSessionlessWidgetRun,
  expireAll: expireSessionlessWidgetRuns,
  extract: extractWidgetFindings,
  gate: egressGate,
  handoffEligible,
  history: recentWidgetTurns,
  inboxHistory: recentInboxTurns,
  latestScope: latestWidgetScope,
  plan: planWidgetChecks,
  progress: saveWidgetProgress,
  read: readWidgetRun,
  requestRecording: requestWidgetRecording,
  route: routeWidgetMessage,
  /** Throws unless the scoped user is a current owner or admin of the scoped workspace. */
  verifyAccess: (scope: WidgetContext) =>
    resolveOwnedIdentifiers(scope, { emails: [], slugs: [], uuids: [] }),
};
export type WidgetDependencies = Omit<
  typeof defaultWidgetDependencies,
  | "answerChat"
  | "changeRequested"
  | "inboxHistory"
  | "plan"
  | "progress"
  | "requestRecording"
> &
  Partial<
    Pick<
      typeof defaultWidgetDependencies,
      | "answerChat"
      | "changeRequested"
      | "inboxHistory"
      | "plan"
      | "progress"
      | "requestRecording"
    >
  >;

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
  /^(?:deadline$|gate_unavailable$|(?:composed:)?(?:foreign_identifier|internal_artifact):)/u;

export function widgetRunResponse(run: WidgetRun) {
  if (!run.outcome) {
    return {
      run_id: run.id,
      status: "pending" as const,
      ...(run.progress ? { progress: run.progress } : {}),
    };
  }
  return {
    ...(run.progress ? { progress: run.progress } : {}),
    decision: run.outcome.decision,
    ...(run.outcome.decision === "block" &&
    RETRYABLE_BLOCK.test(run.outcome.reason ?? "")
      ? { retry: true as const }
      : {}),
    message: run.outcome.message,
    ...(run.recording_requested ? { request_recording: true as const } : {}),
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
/** The app's last poll, counted from when it sent the message. */
const APP_POLL_WINDOW_MS = 285_000;
/**
 * Kept back for saving the outcome: the completion write's own 15-second
 * database deadline (privateDatabase's default) plus a small margin.
 */
const FINISH_SAVE_RESERVE_MS = 17_000;

/** The finish's time source, injectable so its budget can be tested. */
export interface FinishClock {
  now: () => number;
  timeout: (ms: number) => AbortSignal;
}
const systemClock: FinishClock = {
  now: () => Date.now(),
  timeout: (ms) => AbortSignal.timeout(ms),
};

/**
 * The moment the model work (extract, ownership reads, judge, compose) must be
 * done: the earlier of the finish claim running out, counted from when it was
 * taken, and the app's last poll, counted from when it sent the message, less
 * the time to save the outcome. So a slow finish neither lets a second finisher
 * start nor lands after the last poll; once it passes, each step takes its
 * existing failure path.
 */
export const finishCutoff = (
  run: Pick<WidgetRun, "created_at">,
  claimedAt: number
) =>
  Math.min(
    claimedAt + FINISH_CLAIM_SECONDS * 1000,
    run.created_at.getTime() + APP_POLL_WINDOW_MS
  ) - FINISH_SAVE_RESERVE_MS;
const HUMAN_REQUEST_NOTE =
  "The customer asked to speak with a person. Nothing was investigated for this message.";
/**
 * The two modes: owners and admins get the help center and, when they ask for
 * one, investigations; everyone else gets the help center only. Decided in code from the verified
 * role before any routing, because it is a permission boundary.
 */
const INVESTIGATOR_ROLES = new Set<WidgetContext["role"]>(["owner", "admin"]);
/** Help-center mode: the one place a member or client hears about owners and admins. */
export const REFUND_REDIRECT =
  "Refunds aren't something I can help with here. Please reach out to your workspace owner or admin about billing.";
/** An owner or admin's refund or ticket request: only the magnifying glass starts the look that files it (ENG-14841). */
export const INVESTIGATE_REDIRECT =
  "I haven't looked into your workspace for this yet. Tap the magnifying glass next to the message box and send your message again, and I'll dig in.";
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

/** An explicit ask for a person returns its completion promise; other intents return null. */
function requestedHumanHandoff(
  run: WidgetRun,
  route: WidgetRoute,
  deps: Pick<WidgetDependencies, "complete">
): Promise<WidgetRun | null> | null {
  if (route.asksForHuman < HUMAN_REQUEST_SCORE) {
    return null;
  }
  const handoff = humanHandoff(HUMAN_REQUEST_NOTE, "asked_for_human");
  return handoff
    ? deps.complete(run.id, handoff.result, handoff.findings, run.id)
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
    Partial<Pick<WidgetDependencies, "handoffEligible">>,
  signal?: AbortSignal
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
          signal,
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
  run: Pick<
    WidgetRun,
    "created_at" | "id" | "question" | "recording_requested" | "scope"
  >,
  sessionId: string,
  outcome: WaitOutcome,
  deps: Pick<
    WidgetDependencies,
    "claimFinish" | "complete" | "extract" | "gate" | "history"
  > &
    Partial<
      Pick<
        WidgetDependencies,
        "changeRequested" | "handoffEligible" | "progress"
      >
    >,
  clock: FinishClock = systemClock
): Promise<WidgetRun | null> {
  if (outcome.status === "pending") {
    return null;
  }
  const claimedAt = clock.now();
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
  // A question for the customer is not an answer being prepared; saying so
  // would pop the checklist up just before the question arrives.
  if (
    outcome.status === "completed" &&
    !(nextActionEnabled() && outcome.asked)
  ) {
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
    // Asked alongside the write-up passes, so it costs no wait.
    const changeAsked = (
      deps.changeRequested?.(conversation) ?? Promise.resolve(false)
    ).catch(() => false);
    // Everything since the claim, the history read included, came out of it.
    const cutoff = finishCutoff(run, claimedAt);
    const deadline = clock.timeout(Math.max(0, cutoff - clock.now()));
    const extractStartedAt = Date.now();
    const { gateDeps, structured } = await structureWriteUp(
      run,
      sessionId,
      outcome,
      conversation,
      deps,
      deadline
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
        conversation,
        await changeAsked,
        deadline,
        run.recording_requested === true,
        cutoff
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

/** Polls replay the turn; skip already persisted events before making a database call. */
function recordRunProgress(
  run: WidgetRun,
  sessionId: string,
  deps: WidgetDependencies
) {
  let sequence = run.progress?.sequence ?? -1;
  return async (progress: WidgetProgress) => {
    if (run.progress?.stage === "preparing" || progress.sequence <= sequence) {
      return;
    }
    await deps.progress?.(run.id, sessionId, progress);
    ({ sequence } = progress);
  };
}
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
    recordRunProgress(run, sessionId, deps),
    // The saved list keeps its order when the stream is replayed on each poll.
    run.progress?.checks.map((check) => check.id)
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
 * A claimed run that never got a session and is past the deadline is handed to
 * a person, as an overdue investigation is: nothing else will ever finish it,
 * and it would hold the conversation's one open run for good.
 */
async function expireStaleClaim(
  run: WidgetRun,
  deps: Pick<WidgetDependencies, "expire">
): Promise<boolean> {
  if (
    run.outcome ||
    run.session_id ||
    Date.now() - run.created_at.getTime() <= WIDGET_DEADLINE_MS
  ) {
    return false;
  }
  const handoff = humanHandoff(null, "deadline");
  if (
    !(
      handoff &&
      (await deps.expire(
        run.id,
        handoff.result,
        handoff.findings,
        WIDGET_DEADLINE_MS
      ))
    )
  ) {
    return false;
  }
  logGateDecision(
    { conversationId: run.scope.conversationId, runId: run.id },
    handoff.result
  );
  return true;
}

/** The run as it stands once a dead claim, if this is one, is settled. */
const settledIfStale = async (
  run: WidgetRun,
  deps: Pick<WidgetDependencies, "expire" | "read">
) => ((await expireStaleClaim(run, deps)) ? await deps.read(run.id) : run);

/**
 * Claim this message's run. Dead claims of this conversation are settled first,
 * however old: this message then gets its own run, or, when it is the same
 * message, the handoff that settled it.
 */
async function claimOpenRun(
  scope: WidgetContext,
  input: Extract<WidgetInput, { action: "start" }>,
  deps: Pick<WidgetDependencies, "claim" | "expireAll">
) {
  const handoff = humanHandoff(null, "deadline");
  if (handoff) {
    const expired = await deps.expireAll(
      scope,
      handoff.result,
      handoff.findings,
      WIDGET_DEADLINE_MS
    );
    for (const runId of expired) {
      logGateDecision(
        { conversationId: scope.conversationId, runId },
        handoff.result
      );
    }
  }
  return deps.claim(scope, input.message_id, withScreenshots(input));
}

/** In an investigation, a bug report or an explicit ask or offer to send a recording gets the app's recording button. */
const recordingWanted = (route: WidgetRoute, ask: WidgetAsk) =>
  route.bug === true || route.recording === true || offersRecording(ask.latest);

/**
 * Ask the app for its recording button when the turn wants one. True only once
 * the row says so: a failed write shows no button, and loses only the offer.
 */
async function offerRecording(
  run: WidgetRun,
  route: WidgetRoute,
  ask: WidgetAsk,
  deps: Pick<WidgetDependencies, "requestRecording">
): Promise<boolean> {
  if (!(recordingWanted(route, ask) && deps.requestRecording)) {
    return false;
  }
  const offered = await deps.requestRecording(run.id).then(
    () => true,
    () => false
  );
  if (offered) {
    // The investigation's composer reads this same row object.
    run.recording_requested = true;
  }
  return offered;
}

/**
 * Front door, for every message that is not an explicit investigation: an ask
 * for a person hands off at once, a refund or an owner's ticket request gets
 * its fixed next step, and everything else gets the guide lane's reply, or the
 * help-center writer's with WIDGET_CHAT=legacy.
 * Nothing here starts an investigation (ENG-14841), and nothing offers a
 * screen recording.
 */
async function answerFromKnowledgeBase(
  run: WidgetRun,
  scope: WidgetContext,
  ask: WidgetAsk,
  signal: AbortSignal,
  deps: WidgetDependencies,
  helpCenterOnly: boolean
): Promise<WidgetRun | null> {
  const customer = {
    canInvestigate: !helpCenterOnly,
    role: scope.role,
    workspace: scope.organizationName,
  };
  const log = { conversationId: scope.conversationId, runId: run.id };
  // The guide lane starts writing while the router scores the message, and is
  // dropped when the router sends the message somewhere else.
  const drafting = new AbortController();
  const draft = deps.answerChat?.(
    { ...ask, recordingOffered: false },
    log,
    customer,
    AbortSignal.any([signal, drafting.signal])
  );
  const route = await deps.route(ask, { signal }).catch((error: unknown) => {
    drafting.abort();
    throw error;
  });
  logRouteDecision(
    { conversationId: scope.conversationId, runId: run.id },
    route
  );
  const reply = (
    message: string,
    reason: string,
    citations: KbAnswer["citations"] = []
  ) =>
    deps.complete(
      run.id,
      { citations, decision: "allow", message, reason, status: "completed" },
      null,
      // No session exists on this lane, so the run id is the fencing session id.
      run.id
    );
  // An explicit ask for a person is honoured at once. The note tells the
  // teammate why nothing was looked up.
  const handoff = requestedHumanHandoff(run, route, deps);
  if (handoff) {
    drafting.abort();
    return handoff;
  }
  if (draft && !(route.refund || (route.ticket && !helpCenterOnly))) {
    const answer = await draft;
    return reply(answer.message, "kb", answer.citations);
  }
  drafting.abort();
  // Refunds and owner or admin ticket requests have a fixed next step: a member
  // to their owner or admin, an owner or admin to the magnifying glass.
  if (route.refund && helpCenterOnly) {
    return reply(REFUND_REDIRECT, "refund_redirect");
  }
  if (route.refund || (route.ticket && !helpCenterOnly)) {
    return reply(INVESTIGATE_REDIRECT, "investigate_redirect");
  }
  const answer = await deps.answerKb(
    // Every writer is told the button does not show, so none mentions it.
    { ...ask, recordingOffered: false },
    log,
    undefined,
    customer
  );
  return reply(answer.message, "kb", answer.citations);
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
    // Guessed while the session starts, so it costs the customer no wait.
    const planning = (deps.plan ?? (() => Promise.resolve([])))(question, {
      runId: run.id,
    });
    const existing = resolveSession ? await resolveSession(address) : null;
    const startIndex = existing ? await existing.getStreamTailIndex() : 0;
    const session = await from(address).send(question, {
      auth: widgetAuth(scope),
      mode: "task",
      state: { runId: run.id },
    });
    sessionId = session.id;
    await deps.attach(run.id, session.id, startIndex);
    const planned = await planning;
    await deps
      .progress?.(run.id, session.id, {
        checks: planned.map((id) => ({ id, status: "planned" as const })),
        sequence: 0,
        stage: "investigating",
      })
      .catch(() => undefined);
    const settled = waitForWidgetInvestigation(
      session,
      startIndex,
      120_000,
      recordRunProgress(run, session.id, deps),
      planned
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
/**
 * The app vouches for the scope, but a preview admin override names a user the
 * app cannot check, and the app's database can lag the one the tools read.
 * Re-check membership where the tools read. Someone the live database says is
 * not an owner or admin is answered in help-center mode instead; a check that
 * could not run is refused, not one denied tool call at a time.
 */
async function investigationDenied(
  run: WidgetRun,
  scope: WidgetContext,
  deps: WidgetDependencies,
  helpCenter: () => Promise<WidgetRun | null>
): Promise<Response | null> {
  try {
    await deps.verifyAccess(scope);
    return null;
  } catch (error) {
    if (error instanceof WorkspaceAccessDenied) {
      const answered = await helpCenter();
      return json(widgetRunResponse(answered ?? (await deps.read(run.id))));
    }
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
}

/**
 * A fresh run. Only an explicit investigation reaches the investigator: a
 * teammate's, or an owner or admin's toggle (`mode: "investigate"`) or the
 * recording an earlier investigation asked for. Every other message ends at
 * the front door.
 */
async function answerFreshRun(
  run: WidgetRun,
  scope: WidgetContext,
  input: Extract<WidgetInput, { action: "start" }>,
  signal: AbortSignal,
  handlers: Pick<
    RouteHandlerArgs<{ runId: string | null }>,
    "from" | "waitUntil"
  > &
    Partial<Pick<RouteHandlerArgs, "resolveSession">>,
  responseWaitMs: number,
  deps: WidgetDependencies
): Promise<Response> {
  const message = withHistory(input.question, input.history, input.screenshots);
  const ask = toWidgetAsk(
    input.question,
    input.history,
    input.screenshots,
    input.images
  );
  const helpCenterOnly = !INVESTIGATOR_ROLES.has(scope.role);
  const helpCenter = () =>
    answerFromKnowledgeBase(run, scope, ask, signal, deps, true);
  const toggled = input.mode === "investigate";
  const investigate =
    input.staff || ((input.recording || toggled) && !helpCenterOnly);
  if (!investigate) {
    const answered = await answerFromKnowledgeBase(
      run,
      scope,
      ask,
      signal,
      deps,
      helpCenterOnly
    );
    return json(widgetRunResponse(answered ?? (await deps.read(run.id))));
  }
  // Help-center mode never reaches an investigation. A teammate's run in it
  // skipped the front door above, so it is answered here.
  if (helpCenterOnly) {
    const reply = await helpCenter();
    return json(widgetRunResponse(reply ?? (await deps.read(run.id))));
  }
  // Screen recordings belong to the toggle alone (Aaron, 2026-10-06). Jev reads
  // the message while access is checked; the button is asked for only once the
  // look is allowed, so a help-center reply never carries it.
  const routing = toggled ? deps.route(ask, { signal }) : null;
  const denied = await investigationDenied(run, scope, deps, helpCenter);
  if (denied) {
    return denied;
  }
  if (routing) {
    const route = await routing;
    logRouteDecision(
      { conversationId: scope.conversationId, runId: run.id },
      route
    );
    const handoff = requestedHumanHandoff(run, route, deps);
    if (handoff) {
      return json(
        widgetRunResponse((await handoff) ?? (await deps.read(run.id)))
      );
    }
    if (!input.recording) {
      await offerRecording(run, route, ask, deps);
    }
  }
  return json(
    widgetRunResponse(
      await startInvestigation(
        run,
        input.recording ? { ...scope, recordingId: input.recording.id } : scope,
        input.staff
          ? withTeamThread(message, (await deps.inboxHistory?.(run)) ?? [])
          : message,
        handlers,
        responseWaitMs,
        deps
      )
    )
  );
}

/** The customer pressed stop: close the run so their next message starts at once, and stop the investigation spending. */
async function cancelRun(
  run: WidgetRun,
  attachSession: RouteHandlerArgs["attachSession"] | undefined,
  deps: Pick<WidgetDependencies, "cancel" | "read">
) {
  if (!run.outcome) {
    await deps.cancel(run.id);
    if (run.session_id && attachSession) {
      await attachSession(run.session_id)
        .cancel({ tasks: true })
        .catch(() => undefined);
    }
  }
  return widgetRunResponse(await deps.read(run.id));
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
  const refused = serviceSecretRefusal(request);
  if (refused) {
    return refused;
  }
  const userToken = bearer.exec(
    request.headers.get("authorization") ?? ""
  )?.[1];
  if (!userToken) {
    return json({ error: "Identity required." }, 401);
  }
  let input: WidgetInput;
  try {
    const body = await readRequestBody(
      request,
      undefined,
      MAX_START_BODY_CHARS
    );
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
      replayCaseId: request.headers.get("x-widget-replay-case"),
      signal: request.signal,
      staff: input.staff,
      userToken,
    });
  } catch {
    return json({ error: "Workspace could not be verified." }, 403);
  }
  try {
    if (input.action !== "start") {
      let run = await deps.read(input.run_id);
      // A teammate's run is read only through the teammate's verified path.
      if (
        !sameWidgetOwner(run.scope, scope) ||
        run.scope.source !== scope.source
      ) {
        throw new Error("Investigation unavailable for this conversation.");
      }
      if (input.action === "cancel") {
        assertWidgetRunOwner(run, scope);
        return json(await cancelRun(run, attachSession, deps));
      }
      // A dead claim is settled even past the result window, so it stops
      // holding the conversation; its result is still refused below.
      run = await settledIfStale(run, deps);
      assertWidgetRunOwner(run, scope);
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
    const { busy, fresh, run } = await claimOpenRun(scope, input, deps);
    if (busy) {
      return json({ run_id: run.id, status: "busy" });
    }
    if (!fresh) {
      return json(widgetRunResponse(run));
    }
    return await answerFreshRun(
      run,
      scope,
      input,
      request.signal,
      { from, resolveSession, waitUntil },
      responseWaitMs,
      deps
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
