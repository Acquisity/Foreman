import assert from "node:assert/strict";
import { test } from "node:test";
import { existingTicket, inRefundQueue } from "../tools/widget_file_ticket.js";

const SUPPORT = "4534deb2-6bbc-4e30-ad38-48963f414d14";
const REFUND_LABEL = "9120e30d-e188-4972-940b-20005b7f6d03";

const reading = (
  project: string | null,
  labels: string[]
): Parameters<typeof inRefundQueue>[1] => ({
  client: () =>
    Promise.resolve({
      data: {
        data: {
          issue: {
            assignee: null,
            id: "issue-1",
            identifier: "ENG-1",
            labels: { nodes: labels.map((id) => ({ id, name: id })) },
            parent: null,
            priority: 0,
            project: project ? { id: project, name: "Project" } : null,
            state: { name: "Triage" },
            team: { id: "team" },
            url: "https://linear.app/acquisity/issue/ENG-1",
          },
        },
      },
      status: 200,
    }),
});

test("a reused ticket counts as routed to billing only in the Support project with the Refund label", async () => {
  assert.equal(
    await inRefundQueue("ENG-1", reading(SUPPORT, [REFUND_LABEL])),
    true
  );
  // Moved to a product project but still labelled Refund.
  assert.equal(
    await inRefundQueue("ENG-1", reading("other-project", [REFUND_LABEL])),
    false
  );
  assert.equal(await inRefundQueue("ENG-1", reading(SUPPORT, [])), false);
  assert.equal(
    await inRefundQueue("ENG-1", reading(null, [REFUND_LABEL])),
    false
  );
  assert.equal(
    await inRefundQueue("ENG-1", {
      client: () => Promise.resolve({ data: null, status: 500 }),
    }),
    false
  );
});

test("the reused ticket keeps the one-ticket result and carries only the verified refund routing", () => {
  const issue = {
    identifier: "ENG-1",
    url: "https://linear.app/acquisity/issue/ENG-1",
  };
  assert.deepEqual(existingTicket(issue, false), {
    existing: true,
    identifier: "ENG-1",
    refund: false,
    url: "https://linear.app/acquisity/issue/ENG-1",
  });
  assert.equal(existingTicket(issue, true).refund, true);
});
