import assert from "node:assert/strict";
import test from "node:test";

process.env.INTERCOM_MCP_CONNECTOR ??=
  "api.intercom.com/acquisity-foreman-intercom-api";
process.env.LINEAR_CONNECTOR ??= "linear/test";
process.env.PLANETSCALE_MCP_CONNECTOR ??= "planet-scale-read-only-foreman/test";

const { default: intercom } = await import("../connections/intercom.js");

test("Intercom stays app-scoped with the least-privilege tool set", () => {
  assert.equal(typeof intercom.auth, "object");

  if (typeof intercom.auth !== "object" || intercom.auth === null) {
    assert.fail("Intercom auth must be a static app-scoped definition");
  }

  assert.equal(intercom.auth.principalType, "app");
  assert.equal("startAuthorization" in intercom.auth, false);
  assert.deepEqual(intercom.tools, {
    allow: [
      "fetch",
      "get_company",
      "get_contact",
      "get_conversation",
      "list_companies",
      "search",
      "search_contacts",
      "search_conversations",
    ],
  });
});
