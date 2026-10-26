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

// Reads and references in prose may name other tickets. Only a Linear write's
// destination must be this fixture, including mutations inside raw Executor code.
const LINEAR_WRITE =
  /^(?:save_comment|save_document|save_issue|save_investigation_document|route_ticket|reply_to_requester)$/;
const EXECUTOR_LINEAR_WRITE =
  /\b(?:save|create|update|delete|remove|archive|unarchive|attach|link|unlink)_[a-z_]+\b|\bexecuteForemanWrite\b|\bmutation\b/;
const LINEAR_CODE = /linear/i;
const EXECUTOR_CALL =
  /tools(?:\.(?!search\b|describe\b)[\w.]+|\[[^\]]+\])\s*\(/;
const ISSUE_FIELD = /^(?:issue|issueId|issue_id|issueIdentifier|id)$/i;
const writesOnlyIssue = (
  action: { input: unknown; toolName: string },
  id: string,
  identifier: string
): boolean => {
  const input = action.input as Record<string, unknown>;
  const name = action.toolName.split("__").at(-1) ?? "";
  let targets: unknown[];
  if (action.toolName === "executor__execute") {
    const code = typeof input.code === "string" ? input.code : "";
    if (!(LINEAR_CODE.test(code) && EXECUTOR_LINEAR_WRITE.test(code))) {
      return true;
    }
    // An unresolvable mutation destination fails closed. This also covers
    // tools[path](...) after discovering a Linear mutation by name.
    targets = [
      ...code.matchAll(
        /\b(?:issue|issueId|issue_id|issueIdentifier|id)\s*:\s*["']([^"']+)["']/gi
      ),
    ].map((match) => match[1]);
    // Discovery alone does not mutate state.
    if (!(targets.length || EXECUTOR_CALL.test(code))) {
      return true;
    }
  } else if (LINEAR_WRITE.test(name)) {
    targets = Object.entries(input)
      .filter(([key]) => ISSUE_FIELD.test(key))
      .map(([, value]) => value);
  } else {
    return true;
  }
  return (
    targets.length > 0 &&
    targets.every((target) => target === id || target === identifier)
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
              writesOnlyIssue(action, issue.id, issue.identifier)
          ),
        satisfies(
          Boolean,
          "root and child Linear writes target only the SAN ticket"
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
