import assert from "node:assert/strict";
import { test } from "node:test";
import { finInvestigationAuth } from "./lib/fin-investigation-auth.js";
import { verifiedFinContext } from "./lib/fin-investigation-auth.test.js";
import { sandboxSessionOptions } from "./sandbox.js";

test("customer investigations receive a deny-all sandbox network policy", () => {
  assert.deepEqual(
    sandboxSessionOptions(finInvestigationAuth(verifiedFinContext)),
    {
      networkPolicy: "deny-all",
    }
  );
  assert.equal(sandboxSessionOptions(null), undefined);
});
