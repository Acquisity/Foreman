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
// Tools that write to a named issue; each must name the SAN issue.
const ISSUE_WRITES = new Set(["route_ticket", "save_investigation_document"]);

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
      session.eventsSatisfy("issue writes name only the SAN ticket", (events) =>
        events
          .flatMap((event) =>
            event.type === "actions.requested" ? event.data.actions : []
          )
          .every(
            (action) =>
              action.kind !== "tool-call" ||
              !ISSUE_WRITES.has(action.toolName) ||
              (action.input as { issue?: unknown }).issue === issue.identifier
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
