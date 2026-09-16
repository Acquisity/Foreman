import assert from "node:assert/strict";
import { test } from "node:test";
import definition from "../tools/file_fin_investigation_ticket.js";
import statusDefinition from "../tools/read_fin_case_status.js";
import { executorTransport } from "./executor/transport.js";
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

const NO_CASE =
  "No ticket is associated with this conversation, so there is no team status to report.";
const UNAVAILABLE =
  "The current status of this report could not be checked. Do not describe it as resolved or as unresolved.";

/** Answer the lane's own list_issues search with a fixed page and read the status back. */
const readStatus = async (list: unknown) => {
  const resolve = statusDefinition.events["step.started"];
  const tool = await resolve?.({} as never, verified);
  assert.ok(tool && typeof tool === "object" && "execute" in tool);
  const original = executorTransport.call;
  const originalConnector = process.env.EXECUTOR_MCP_CONNECTOR;
  process.env.EXECUTOR_MCP_CONNECTOR = "executor.test/fin";
  executorTransport.call = ((...args: unknown[]) =>
    Promise.resolve({
      data: args[1] === "linear.org.workspaceLinear.list_issues" ? list : null,
      ok: true,
    })) as typeof executorTransport.call;
  try {
    return await tool.execute({}, {
      abortSignal: AbortSignal.timeout(1000),
      getToken: async () => ({ token: "test-token" }),
      session: {
        auth: { initiator: finInvestigationAuth(verifiedFinContext) },
      },
    } as never);
  } finally {
    executorTransport.call = original;
    if (originalConnector === undefined) {
      delete process.env.EXECUTOR_MCP_CONNECTOR;
    } else {
      process.env.EXECUTOR_MCP_CONNECTOR = originalConnector;
    }
  }
};

test("an untruncated empty search is the only proof that no ticket exists", async () => {
  assert.deepEqual(await readStatus({ hasNextPage: false, issues: [] }), {
    message: NO_CASE,
  });
});

for (const [name, list] of [
  ["a truncated page", { hasNextPage: true, issues: [] }],
  [
    "two matches",
    {
      hasNextPage: false,
      issues: [{ id: "ENG-13902" }, { id: "ENG-13903" }],
    },
  ],
  ["a page that does not say whether it is complete", { issues: [] }],
] as const) {
  test(`${name} reports unchecked status, never that no ticket exists`, async () => {
    assert.deepEqual(await readStatus(list), { message: UNAVAILABLE });
  });
}
