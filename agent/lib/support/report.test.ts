import assert from "node:assert/strict";
import { test } from "node:test";
import { supportReport } from "./investigation.js";

test("support summaries preserve readable paragraphs and ticket links", () => {
  const summary =
    "Jordan AI is returning blank replies. This is a confirmed bug.\n\n" +
    "Aaron: route the fix; rephrasing will not resolve it.\n\n" +
    "[Customer report: ENG-13629](https://linear.app/acquisity/issue/ENG-13629)";
  assert.deepEqual(supportReport.parse({ summary }), {
    retry: false,
    summary,
  });
  assert.equal(supportReport.parse({ retry: true, summary }).retry, true);
});

test("support summaries reject empty or oversized reports instead of truncating them", () => {
  for (const summary of ["", " \n ", "x".repeat(1201)]) {
    assert.equal(supportReport.safeParse({ summary }).success, false);
  }
  assert.equal(
    supportReport.parse({ summary: "x".repeat(1200) }).summary.length,
    1200
  );
  assert.equal(
    supportReport.parse({ summary: "  No action needed.  " }).summary,
    "No action needed."
  );
  assert.equal(
    supportReport.safeParse({
      alreadyTried: "Read the conversation.",
      findings: "No action needed.",
      issue: "Question answered.",
      nextStep: "None.",
    }).success,
    false
  );
});
