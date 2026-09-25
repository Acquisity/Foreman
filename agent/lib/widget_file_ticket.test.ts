import assert from "node:assert/strict";
import { test } from "node:test";
import { existingTicket } from "../tools/widget_file_ticket.js";

const issue = (labels: string[]) => ({
  identifier: "ENG-1",
  labels,
  url: "https://linear.app/acquisity/issue/ENG-1",
});

test("reusing an ordinary ticket for a refund does not claim the refund reached billing", () => {
  assert.equal(existingTicket(issue(["Bug"]), true).refund, false);
  assert.equal(existingTicket(issue(["Refund"]), true).refund, true);
  assert.equal(existingTicket(issue(["Refund"]), false).refund, false);
  assert.deepEqual(existingTicket(issue([]), false), {
    existing: true,
    identifier: "ENG-1",
    refund: false,
    url: "https://linear.app/acquisity/issue/ENG-1",
  });
});
