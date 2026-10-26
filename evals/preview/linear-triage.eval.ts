import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { loadJson } from "eve/evals/loaders";
import {
  cancelIssue,
  fileSandboxIssue,
  matchRun,
  previewBuild,
  requesterReplies,
  requireQa,
} from "./helpers.js";

interface Fixture {
  achieve: string;
  customerEmail: string;
  customerName: string;
  doing: string;
  expected: string;
  instead: string;
  requester: string;
  title: string;
  workspaceName: string;
}

const fixture = (await loadJson(
  "evals/preview/fixtures/l1-triage.json"
)) as Fixture;
const description = [
  ["Customer Name", fixture.customerName],
  ["Customer Email", fixture.customerEmail],
  ["Workspace name", fixture.workspaceName],
  ["What are you trying to achieve?", fixture.achieve],
  ["What are you doing to achieve it?", fixture.doing],
  ["What is happening instead?", fixture.instead],
  ["What is the expected outcome?", fixture.expected],
]
  .map(([heading, answer]) => `#### ${heading}\n\n${answer}`)
  .join("\n\n");

// Audit every tool input, including raw Executor requests, rather than keeping
// a list of writable tools. Reads naming another ticket also fail this check.
const ENG_ISSUE = /\bENG-\d+\b/;
const LINEAR_ISSUE = /\b[A-Z][A-Z0-9]*-\d+\b/g;
const ISSUE_FIELD = /^(issue|issueId|issue_id|issueIdentifier)$/i;
const namesOnlyIssue = (
  input: unknown,
  id: string,
  identifier: string
): boolean => {
  const text = JSON.stringify(input) ?? "";
  if (ENG_ISSUE.test(text)) {
    return false;
  }
  if ((text.match(LINEAR_ISSUE) ?? []).some((key) => key !== identifier)) {
    return false;
  }
  if (!input || typeof input !== "object") {
    return true;
  }
  return Object.entries(input).every(([key, value]) =>
    ISSUE_FIELD.test(key) && typeof value === "string"
      ? value === id || value === identifier
      : namesOnlyIssue(value, id, identifier)
  );
};

export default defineEval({
  description:
    "L1: a SAN intake ticket delegated to Foreman Preview is triaged end to end: the investigation document is saved, the requester gets one reply, and nothing is written outside the ticket.",
  tags: ["preview"],
  async test(t) {
    requireQa(t, "LINEAR_SANDBOX_API_KEY");
    const build = await previewBuild(t);
    const since = new Date();
    const issue = await fileSandboxIssue(
      fixture.title,
      description,
      fixture.requester
    );
    try {
      t.log(`filed ${issue.identifier}`);
      const runId = await matchRun(
        t,
        build,
        "linear",
        `identifier="${issue.identifier}"`,
        since
      );
      const session = await t.target.attachSession(runId);
      session.succeeded();
      const events = [...session.events];
      const children = new Set<string>();
      for (const event of events) {
        if (
          event.type !== "agent.started" ||
          children.has(event.data.sessionId)
        ) {
          continue;
        }
        children.add(event.data.sessionId);
        const signal = AbortSignal.any([t.signal, AbortSignal.timeout(30_000)]);
        // The root has settled. Read all recorded turns of each child, and
        // include any nested sessions its task opened in the same audit.
        // biome-ignore lint/performance/noAwaitInLoops: each stream can announce more children to audit.
        for await (const child of session.agent(event).stream({
          follow: false,
          signal,
        })) {
          events.push(child);
        }
        signal.throwIfAborted();
      }
      await t.require(
        events
          .flatMap((event) =>
            event.type === "actions.requested" ? event.data.actions : []
          )
          .every(
            (action) =>
              action.kind !== "tool-call" ||
              namesOnlyIssue(action.input, issue.id, issue.identifier)
          ),
        satisfies(
          Boolean,
          "root and child tool inputs name only the SAN ticket and no ENG issue"
        )
      );
      const { documents, replies } = await requesterReplies(issue);
      await t.require(
        documents.some((title) => title.endsWith("investigation")),
        satisfies(Boolean, "an investigation document is saved on the ticket")
      );
      await t.require(
        replies.length === 1,
        satisfies(Boolean, "the requester gets exactly one reply")
      );
    } finally {
      await cancelIssue(issue.id);
    }
  },
  timeoutMs: 1_800_000,
});
