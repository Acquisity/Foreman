import { z } from "zod";
import { readRequestBody } from "./bounded-body.js";
import { logOpsEvent } from "./ops-log.js";
import {
  type BugReportBrowser,
  bugReportBrowser,
  MAX_BROWSER_CHARS,
} from "./widget-bug-evidence.js";
import {
  draftHandoffTicket,
  type HandoffFacts,
  handoffTicketBody,
} from "./widget-bug-report.js";
import { verifyWidgetContext } from "./widget-context.js";
import { verifyWorkspaceMember } from "./widget-evidence.js";
import type { WidgetContext } from "./widget-scope.js";
import {
  noStoreJson,
  serviceSecretRefusal,
  widgetUserToken,
} from "./widget-service-secret.js";
import { inert } from "./widget-support-report.js";
import { fileTicketFor } from "./widget-ticket.js";

/**
 * The customer's "Report a problem" on a Foreman reply, or on the whole
 * conversation (ENG-21100), filed like every other widget ticket: the same
 * drafting call, the same Support chat link, and the ids, transcript and
 * browser capture in its Support report, ending with the machine line the
 * widget-feedback route reads. Only the customer's own report comes here; a
 * teammate's report from the inbox is a staff entry point and stays in
 * Acquisity.
 */

const TURNS_MAX = 12;
const TURN_CHARS = 2000;
const DETAILS_MAX = 2000;
const REPORT_MS = 45_000;

const inputSchema = z.strictObject({
  /** The browser capture; an invalid one is dropped, never refused. */
  browser: z.unknown().optional(),
  conversation_id: z.uuid(),
  details: z.string().trim().max(DETAILS_MAX).optional(),
  /** The ticket Acquisity filed for this reply before ENG-21100, which this report then lands on. */
  earlier_ticket: z
    .string()
    .regex(/^ENG-\d{1,7}$/u)
    .optional(),
  /** Customer-visible turns, oldest first, ending at the reported reply. */
  history: z
    .array(
      z.strictObject({
        role: z.enum(["customer", "assistant"]),
        text: z.string().max(TURN_CHARS),
      })
    )
    .max(TURNS_MAX),
  /** The reported Foreman reply; absent for a report on the whole conversation. */
  message_id: z.uuid().optional(),
  organization_id: z.uuid(),
  /** The same on every retry of one report, so a slow write is not doubled. */
  report_id: z.uuid(),
  run_id: z.uuid().optional(),
});
export type ProblemReport = z.infer<typeof inputSchema>;

const MAX_BODY_CHARS =
  (DETAILS_MAX + TURNS_MAX * TURN_CHARS + MAX_BROWSER_CHARS) * 6 + 4096;

const fenced = (lines: string[]) =>
  lines.length
    ? lines.map((line) => `    ${inert(line)}`).join("\n")
    : "(none)";

const browserSection = (browser: BugReportBrowser, reportedAt: string) => {
  const org = process.env.WIDGET_SENTRY_ORG_SLUG;
  return [
    "## Browser",
    `Reported at: ${reportedAt}`,
    `Page: ${inert(browser.page)}`,
    `Browser: ${inert(browser.browser)}   Screen: ${inert(browser.screen)}`,
    `Sentry replay: ${browser.replayId && org ? `https://${org}.sentry.io/replays/${browser.replayId}/` : (browser.replayId ?? "none")}`,
    `Sentry errors: ${browser.sentryEventIds.length ? browser.sentryEventIds.join(", ") : "none"}`,
    "### Console errors (newest last)",
    fenced(browser.consoleErrors),
    "### Failed network calls (newest last)",
    fenced(browser.failedRequests),
  ].join("\n\n");
};

/**
 * The Support report's sections in the format the widget-feedback skill
 * reads, ending with its machine line.
 */
export const problemReportSections = (
  input: ProblemReport,
  browser: BugReportBrowser | undefined,
  reportedAt: string
) => [
  "## Report",
  [
    "Reported by: Customer",
    `What went wrong: ${input.details ? inert(input.details) : "(no details given)"}`,
  ].join("\n\n"),
  "## Conversation",
  [
    `Reported reply: ${input.message_id ?? "whole conversation"}`,
    `Foreman run: ${input.run_id ?? "unknown"}`,
  ].join("\n\n"),
  "### Transcript (oldest first, customer-visible turns only)",
  input.history.length
    ? input.history
        .map(
          ({ role, text }) =>
            `${role === "customer" ? "Customer" : "Foreman"}: ${inert(text)}`
        )
        .join("\n\n")
    : "(no messages)",
  ...(browser ? [browserSection(browser, reportedAt)] : []),
  `<!-- chat-widget-feedback conversation=${input.conversation_id} message=${input.message_id ?? "none"} run=${input.run_id ?? "none"} replay=${browser?.replayId ?? "none"} at=${reportedAt} -->`,
];

const reportFacts = (input: ProblemReport): HandoffFacts => {
  const last = input.history.at(-1);
  const reply =
    input.message_id && last?.role === "assistant" ? last.text : undefined;
  return {
    history: reply ? input.history.slice(0, -1) : input.history,
    latest: input.details || "(The customer gave no details.)",
    ...(reply ? { reply } : {}),
    why: input.message_id
      ? "The customer used Report a problem on this Foreman reply in the support chat."
      : "The customer used Report a problem on this support conversation.",
  };
};

export const problemReportDependencies = {
  draft: draftHandoffTicket,
  file: fileTicketFor,
  member: (scope: WidgetContext, signal: AbortSignal) =>
    verifyWorkspaceMember(scope, signal),
  now: () => new Date(),
  verify: verifyWidgetContext,
};

const json = noStoreJson;

/** POST /internal/widget/report: file the customer's report, or add it to the one this chat already has. */
export async function receiveProblemReport(
  request: Request,
  overrides: Partial<typeof problemReportDependencies> = {}
): Promise<Response> {
  const deps = { ...problemReportDependencies, ...overrides };
  const refused = serviceSecretRefusal(request);
  if (refused) {
    return refused;
  }
  const userToken = widgetUserToken(request);
  if (!userToken) {
    return json({ error: "Identity required." }, 401);
  }
  let input: ProblemReport;
  try {
    const body = await readRequestBody(request, undefined, MAX_BODY_CHARS);
    if (body === null) {
      return json({ error: "Request is too large." }, 413);
    }
    input = inputSchema.parse(JSON.parse(body));
  } catch {
    return json({ error: "Invalid report." }, 400);
  }
  const signal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(REPORT_MS),
  ]);
  let scope: WidgetContext;
  try {
    scope = await deps.verify({
      conversationId: input.conversation_id,
      organizationId: input.organization_id,
      signal,
      userToken,
    });
    await deps.member(scope, signal);
  } catch {
    return json({ error: "Workspace could not be verified." }, 403);
  }
  const { browser } = bugReportBrowser(input.browser);
  const reportedAt = deps.now().toISOString();
  const facts = reportFacts(input);
  const draft = await deps.draft(facts, signal);
  const filed = await deps
    .file(
      scope,
      {
        body: handoffTicketBody(draft, facts, scope, deps.now()),
        entry: "problem",
        feedback: {
          ...(input.earlier_ticket ? { earlier: input.earlier_ticket } : {}),
          message: input.message_id ?? "none",
        },
        report: problemReportSections(input, browser, reportedAt),
        retryKey: `problem-report:${input.report_id}`,
        summary: facts.latest,
        title: draft.title.slice(0, 160),
      },
      signal
    )
    .catch(() => ({ error: "unavailable" }));
  const ok = "identifier" in filed;
  const existing = "existing" in filed && filed.existing;
  let decision = "unfiled";
  if (ok) {
    decision = existing ? "existing" : "filed";
  }
  logOpsEvent("widget.problem_report", {
    conversationId: scope.conversationId,
    decision,
  });
  return ok
    ? json({
        existing,
        ticket: { id: filed.identifier, url: filed.url },
      })
    : json({ error: "The report could not be filed." }, 502);
}
