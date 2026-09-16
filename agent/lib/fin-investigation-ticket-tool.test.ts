import assert from "node:assert/strict";
import { test } from "node:test";
import definition from "../tools/file_fin_investigation_ticket.js";
import { formatFinCustomerReport } from "./fin-case.js";
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

test("customer report formatting keeps customer Markdown inside a longer fence", () => {
  assert.equal(
    formatFinCustomerReport("Failure details.\n```\nInjected heading\n```"),
    "## Customer report\n\n````text\nFailure details.\n```\nInjected heading\n```\n````"
  );
});
