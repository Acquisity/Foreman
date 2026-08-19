import type { MessageStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

/**
 * Tool calls that read the repository's label vocabulary before a write.
 */
const VOCABULARY_READS = new Set([
  "github__getIssueContext",
  "github__listLabels",
]);

/**
 * Tool calls that can mirror the classification onto the issue. Both are
 * legitimate: `addLabels` writes labels alone, `updateIssue` batches them
 * with other fields, and pinning one would fail a correct run that chose
 * the other.
 */
const LABEL_WRITES = new Set(["github__addLabels", "github__updateIssue"]);

const toolCallOrder = (events: readonly MessageStreamEvent[]) => {
  const order: Array<{ name: string; inputs: unknown }> = [];
  for (const event of events) {
    if (event.type !== "actions.requested") {
      continue;
    }
    for (const action of event.data.actions) {
      if (action.kind === "tool-call") {
        order.push({ inputs: action.input, name: action.toolName });
      }
    }
  }
  return order;
};

export default defineEval({
  description:
    "Classifying Acquisity/Foreman issue #1 uses that explicit repository, reads its label vocabulary before any write, and never consults a deployment-wide repository setting.",
  // Not tagged `fast`: this eval needs a live repository with an open issue,
  // which a cheap local loop cannot provide, so it runs only as a separately
  // provisioned `needs-connect` test.
  tags: ["needs-connect"],
  async test(t) {
    await t.send(
      "Use factory mode to classify Acquisity/Foreman issue #1 and mirror the classification onto that issue, then stop before investigation."
    );
    t.loadedSkill("factory-pipeline");
    t.calledSubagent("classifier");
    t.calledSubagent("analyst", { count: 0 });
    t.calledSubagent("investigator", { count: 0 });
    t.calledSubagent("implementer", { count: 0 });
    t.parked();
    t.check(
      t.pendingInputRequests.map((request) => request.action.toolName),
      satisfies(
        (names: readonly string[]) =>
          names.some((name) => LABEL_WRITES.has(name)),
        "a label write is among the pending approvals"
      )
    );
    t.eventsSatisfy(
      "reads the repo's label vocabulary before writing labels",
      (events) => {
        const order = toolCallOrder(events);
        const writeAt = order.findIndex(({ name }) => LABEL_WRITES.has(name));
        const readAt = order.findIndex(({ name }) =>
          VOCABULARY_READS.has(name)
        );
        const githubCalls = order.filter(({ name }) =>
          name.startsWith("github__")
        );
        const bound = githubCalls.every(({ inputs }) => {
          if (!inputs || typeof inputs !== "object") {
            return false;
          }
          const value = inputs as Record<string, unknown>;
          const issue =
            value.issueNumber ?? value.issue_number ?? value.number;
          return (
            value.owner === "Acquisity" &&
            value.repo === "Foreman" &&
            (issue === undefined || issue === 1)
          );
        });
        return writeAt !== -1 && readAt !== -1 && readAt < writeAt && bound;
      }
    );
  },
});
