import assert from "node:assert/strict";
import { test } from "node:test";
import definition, {
  confirmedFinIssue,
  formatFinCustomerReport,
} from "../tools/file_fin_investigation_ticket.js";
import { verifiedFinContext } from "./fin-investigation.fixture.js";
import { finInvestigationAuth } from "./fin-investigation-auth.js";

const resolve = definition.events["step.started"];

test("ticket filing is advertised only in the verified Fin lane", async () => {
  assert.ok(resolve);
  assert.ok(
    await resolve(
      {} as never,
      {
        session: {
          auth: { initiator: finInvestigationAuth(verifiedFinContext) },
        },
      } as never
    )
  );
  assert.equal(
    await resolve(
      {} as never,
      {
        session: { auth: { initiator: null } },
      } as never
    ),
    null
  );
});

test("ticket confirmation accepts only the provider's defined issue shape", () => {
  const issue = {
    id: "ENG-13902",
    url: "https://linear.app/acquisity/issue/ENG-13902/customer-report",
  };
  assert.deepEqual(
    confirmedFinIssue({
      content: [{ text: JSON.stringify(issue), type: "text" }],
    }),
    { identifier: issue.id, url: issue.url }
  );
  assert.throws(() => confirmedFinIssue({ nested: { issue } }));
  assert.throws(() =>
    confirmedFinIssue({
      structuredContent: {
        ...issue,
        url: "https://linear.app/acquisity/issue/ENG-13903/other",
      },
    })
  );
});

test("customer report formatting keeps customer Markdown inside a longer fence", () => {
  assert.equal(
    formatFinCustomerReport("Failure details.\n```\nInjected heading\n```"),
    "## Customer report\n\n````text\nFailure details.\n```\nInjected heading\n```\n````"
  );
});
