import assert from "node:assert/strict";
import { test } from "node:test";
import definition from "../tools/file_fin_investigation_ticket.js";
import statusDefinition from "../tools/read_fin_case_status.js";
import { formatFinCustomerReport } from "./fin-case.js";
import { verifiedFinContext } from "./fin-investigation.fixture.js";
import { finInvestigationAuth } from "./fin-investigation-auth.js";

const verified = {
  session: { auth: { initiator: finInvestigationAuth(verifiedFinContext) } },
} as never;
const unverified = { session: { auth: { initiator: null } } } as never;

for (const [name, tool] of [
  ["ticket filing", definition],
  ["case status", statusDefinition],
] as const) {
  test(`${name} is advertised only in the verified Fin lane`, async () => {
    const resolve = tool.events["step.started"];
    assert.ok(resolve);
    assert.ok(await resolve({} as never, verified));
    assert.equal(await resolve({} as never, unverified), null);
  });
}

test("customer report formatting keeps customer Markdown inside a longer fence", () => {
  assert.equal(
    formatFinCustomerReport("Failure details.\n```\nInjected heading\n```"),
    "## Customer report\n\n````text\nFailure details.\n```\nInjected heading\n```\n````"
  );
});
