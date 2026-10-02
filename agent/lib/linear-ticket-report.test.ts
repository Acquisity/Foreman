import assert from "node:assert/strict";
import { test } from "node:test";
import {
  confirmedIssue,
  formatCustomerReport,
} from "./linear-ticket-report.js";

test("ticket confirmation accepts only the provider's defined issue shape", () => {
  const issue = {
    id: "ENG-13902",
    url: "https://linear.app/acquisity/issue/ENG-13902/customer-report",
  };
  assert.deepEqual(
    confirmedIssue({
      content: [{ text: JSON.stringify(issue), type: "text" }],
    }),
    { identifier: issue.id, url: issue.url }
  );
  assert.throws(() => confirmedIssue({ nested: { issue } }));
  assert.throws(() =>
    confirmedIssue({
      structuredContent: {
        ...issue,
        url: "https://linear.app/acquisity/issue/ENG-13903/other",
      },
    })
  );
});

test("customer report formatting keeps customer Markdown inside a longer fence", () => {
  assert.equal(
    formatCustomerReport("Failure details.\n```\nInjected heading\n```"),
    "## Customer report\n\n````text\nFailure details.\n```\nInjected heading\n```\n````"
  );
});
