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

test("a customer report is the plain Markdown body, never wrapped in a code block, with tags kept literal and quotes kept", () => {
  assert.equal(
    formatCustomerReport(
      "## What the customer wants\n\nCancel before renewal. <img src=x>\n\n> Their words\n"
    ),
    "## What the customer wants\n\nCancel before renewal. &lt;img src=x>\n\n> Their words"
  );
});

test("text in a customer report cannot open a code block, so an unclosed fence never swallows the scope block after it", () => {
  assert.equal(
    formatCustomerReport(
      "Try this:\n```\nsteps\n~~~ and `code`\n\n    indented log line \\` here"
    ),
    "Try this:\n\\`\\`\\`\nsteps\n\\~\\~\\~ and \\`code\\`\n\nindented log line \\\\\\` here"
  );
});
