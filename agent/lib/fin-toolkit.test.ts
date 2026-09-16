import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApprovalContext } from "eve/tools/approval";
import { describeProvider, invokeProvider } from "./executor/dispatch.js";
import { FIN_PREVIEW_TOOLKIT, toolkitUrl } from "./executor/endpoint.js";
import { executorTransport } from "./executor/transport.js";
import { finCaseSearch } from "./fin-case.js";
import { verifiedFinContext } from "./fin-investigation.fixture.js";
import {
  FIN_INVESTIGATION_ISSUER,
  finInvestigationAuth,
} from "./fin-investigation-auth.js";
import { finPolicy } from "./github/approval.js";
import { composePrompt } from "./prompts.js";
import { repositoryCapabilitiesAvailable } from "./repository-lane.js";
import { sessionLane } from "./session-lane.js";
import { canUseInvestigationMemory } from "./trust.js";

const initiator = finInvestigationAuth(verifiedFinContext);
const session = { auth: { current: initiator, initiator } };
const READ_PATH =
  "planetscale.org.foremanPlanetscale.planetscale_execute_read_query";
const STATE_CHANGE = /changes provider state/;
const WORKSPACE = /aaron-fragas-workspace-wMUMT/;
const IMMUTABLE = /immutable/;
const QUALIFIED_REPORT = /qualified customer report/;
const COMPLETE_NOW = /perform that bounded action in the root turn/;
const ORGANIZATION_BIND = /verified organization id/;
const REPOSITORIES = /Repository selection and workspaces/;
const MEMORY = /Investigation memory/;
const MODEL_CONTROLS = /Model controls/;
const INVALID_SCOPE = /no valid verified scope/;

const ctx = (id = "fin-session") =>
  ({
    abortSignal: AbortSignal.timeout(2000),
    getToken: () => Promise.resolve({ token: "test-token" }),
    session: { ...session, id },
  }) as never;

/** Capture what each call put on the wire without reaching the network. */
function record<T extends "call" | "describe">(key: T, data: unknown = {}) {
  const original = executorTransport[key];
  const wires: { toolkit?: string }[] = [];
  (executorTransport as Record<string, unknown>)[key] = (
    wire: { toolkit?: string },
    ..._rest: unknown[]
  ) => {
    wires.push(wire);
    return Promise.resolve(data);
  };
  return {
    restore: () => {
      (executorTransport as Record<string, unknown>)[key] = original;
    },
    wires,
  };
}

/** The shape the lane's own evidence reads used before the toolkit replaced them. */
const legitimateRead = (id: string) => `with authorized as (
    select o.id from organization o join member m on m.organization_id = o.id
    where o.id = '${id}'::uuid and m.user_id = '${verifiedFinContext.userId}'::uuid
      and o.deleted_at is null and m.deleted_at is null and m.role in ('owner', 'admin')
  )
  select c.id, left(c.name, 300) as name, c.status
  from outreach_campaign c
    join authorized a on a.id = c.organization_id
    join outreach_provider p on p.id = c.provider_id and p.organization_id = a.id
  where c.display_status = 'active' order by c.id limit 51`;

const OTHER_ORGANIZATION = "0f1e2d3c-4b5a-4968-8877-665544332211";

const read = (query: string) => invokeProvider(ctx(), READ_PATH, { query });
const refused = (error: { code?: string; dispatched?: unknown }) =>
  error.code === "customer_organization_scope_required" &&
  error.dispatched === false;

test("a Fin product database read must bind the verified organization id", async () => {
  const id = verifiedFinContext.organizationId;
  const scoped = record("call", { data: { rows: [] }, ok: true });
  try {
    for (const query of [
      // The verified id present as text, with no predicate binding it at all.
      `select * from campaign where organization_id != '${id}'`,
      `select * from campaign where organization_id <> '${id}'`,
      `select * from campaign where organization_id in ('${id}', '${OTHER_ORGANIZATION}')`,
      `select * from users -- ${id}`,
      `select * from users /* ${id} */`,
      `select * from users union select * from users -- ${id}`,
      `select * from organization o where not (o.id = '${id}'::uuid)`,
      `select * from campaign where organization_id not in ('${OTHER_ORGANIZATION}') and organization_id = '${id}'`,
      // A second statement behind one that would have passed on its own.
      `select 1 from organization o where o.id = '${id}'::uuid; select * from users`,
      // A bind to somebody else, and no bind at all.
      `select * from organization o where o.id = '${OTHER_ORGANIZATION}'::uuid`,
      "select * from users",
      // A subquery or a function in place of the verified literal.
      `select * from campaign where organization_id = any(select id from organization) and organization_id = '${id}'`,
      `select * from campaign c join authorized a on a.id = c.organization_id where c.organization_id = (select id from organization limit 1) and a.id = '${id}'`,
      // Past the input bound, with a real bind inside it.
      `${legitimateRead(id)} ${"-".repeat(0)}${" ".repeat(20_001)}`,
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each refusal is checked in order.
      await assert.rejects(read(query), refused, query.slice(0, 90));
    }
    assert.equal(scoped.wires.length, 0, "a refused read never dispatches");

    for (const query of [
      legitimateRead(id),
      `select id from organization where id = '${id}'`,
      `select id from organization where "id" = '${id}'::uuid`,
      `select * from outreach_provider p join authorized a on a.id = p.organization_id where a.id = '${id}'::uuid and p.connection_error is not null`,
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each read is dispatched in order.
      await read(query);
    }
    assert.equal(scoped.wires.length, 4);
  } finally {
    scoped.restore();
  }
});

test("a Fin PlanetScale call without a query is refused", async () => {
  const scoped = record("call", { data: { rows: [] }, ok: true });
  try {
    await assert.rejects(
      invokeProvider(
        ctx(),
        "planetscale.org.foremanPlanetscale.list_branches",
        {
          organization: verifiedFinContext.organizationId,
        }
      ),
      refused
    );
    assert.equal(scoped.wires.length, 0);
  } finally {
    scoped.restore();
  }
});

const STRIPE_READ =
  "foreman_stripe_api.org.foremanStripeApi.customers.readCustomer";
const FOREIGN_STRIPE = "cus_NffrFeUfNV2Hib";
const LEARNED_STRIPE = "cus_PqRs8TuVwXyZ01";
const PROVENANCE = /neither belongs to this conversation/;

const unknownIdentifier = (error: {
  code?: string;
  dispatched?: unknown;
  message?: string;
}) =>
  error.code === "customer_identifier_provenance_required" &&
  error.dispatched === false &&
  PROVENANCE.test(String(error.message));

test("a Fin call naming a tenant with no provenance is refused", async () => {
  // A distinct session id: the learned set is per session and lives in memory.
  const sessionId = "fin-provenance-refused";
  const scoped = record("call", { data: { id: LEARNED_STRIPE }, ok: true });
  try {
    await assert.rejects(
      invokeProvider(ctx(sessionId), STRIPE_READ, { customer: FOREIGN_STRIPE }),
      unknownIdentifier
    );
    await assert.rejects(
      invokeProvider(
        ctx(sessionId),
        "intercom.org.foremanIntercom.get_conversation",
        {
          id: "987654321098765",
        }
      ),
      unknownIdentifier
    );
    await assert.rejects(
      invokeProvider(
        ctx(sessionId),
        "foreman_linear_read_api.org.foremanLinearReadOnlyApi.graphql.executeForemanRead",
        {
          body: {
            query: `query { organization(id: "${OTHER_ORGANIZATION}") { id } }`,
          },
        }
      ),
      unknownIdentifier
    );
    assert.equal(scoped.wires.length, 0, "a refused call never dispatches");
  } finally {
    scoped.restore();
  }
});

test("a Fin call carrying the verified scope's own values is allowed", async () => {
  const sessionId = "fin-provenance-scope";
  const scoped = record("call", { data: { id: "ok" }, ok: true });
  try {
    await invokeProvider(
      ctx(sessionId),
      "intercom.org.foremanIntercom.get_conversation",
      {
        id: verifiedFinContext.conversationId,
      }
    );
    await invokeProvider(
      ctx(sessionId),
      "intercom.org.foremanIntercom.get_contact",
      {
        id: verifiedFinContext.contactId,
      }
    );
    await invokeProvider(ctx(sessionId), STRIPE_READ, {
      metadata: { organization: verifiedFinContext.organizationId },
    });
    assert.equal(scoped.wires.length, 3);
  } finally {
    scoped.restore();
  }
});

test("an identifier learned from an earlier successful call is reachable", async () => {
  const sessionId = "fin-provenance-learned";
  const listed = record("call", {
    data: { customers: [{ id: LEARNED_STRIPE, organization: "acquisity" }] },
    ok: true,
  });
  try {
    await assert.rejects(
      invokeProvider(ctx(sessionId), STRIPE_READ, { customer: LEARNED_STRIPE }),
      unknownIdentifier
    );
    // The scoped list returns it, which is the provenance the next call needs.
    await invokeProvider(
      ctx(sessionId),
      "foreman_stripe_api.org.foremanStripeApi.customers.listCustomers",
      {
        organization: verifiedFinContext.organizationSlug,
      }
    );
    await invokeProvider(ctx(sessionId), STRIPE_READ, {
      customer: LEARNED_STRIPE,
    });
    assert.equal(listed.wires.length, 2);
    // A failed call teaches nothing.
    await assert.rejects(
      invokeProvider(ctx(sessionId), STRIPE_READ, { customer: FOREIGN_STRIPE }),
      unknownIdentifier
    );
  } finally {
    listed.restore();
  }
});

test("a Fin session resolves its own toolkit and an ordinary session the shared one", async () => {
  assert.equal(
    toolkitUrl(FIN_PREVIEW_TOOLKIT),
    "https://executor.acquisity.ai/mcp/toolkits/foreman-fin-preview?artifacts=false"
  );
  assert.equal(
    toolkitUrl(),
    "https://executor.acquisity.ai/mcp/toolkits/foreman?artifacts=false"
  );
  const described = record("describe");
  try {
    await describeProvider(ctx(), READ_PATH);
    assert.equal(described.wires[0]?.toolkit, FIN_PREVIEW_TOOLKIT);
    await describeProvider(
      {
        abortSignal: AbortSignal.timeout(2000),
        getToken: () => Promise.resolve({ token: "test-token" }),
      } as never,
      READ_PATH
    );
    assert.equal(described.wires[1]?.toolkit, undefined);
  } finally {
    described.restore();
  }
});

test("finPolicy denies a provider write from a customer conversation", () => {
  const approve = (path: string, auth = session.auth) =>
    finPolicy({
      approvedTools: [],
      session: { auth },
      toolInput: { action: "call", input: {}, path },
      toolName: "fin_provider",
    } as never as ApprovalContext);
  const denied = approve("slack.org.foremanSlack.send_message") as {
    reason: string;
    type: string;
  };
  assert.equal(denied.type, "denied");
  assert.match(denied.reason, STATE_CHANGE);
  assert.equal(
    (approve("linear.org.workspaceLinear.save_issue") as { type: string }).type,
    "denied"
  );
  assert.equal(approve(READ_PATH), "not-applicable");
  assert.equal(
    approve("intercom.org.foremanIntercom.get_conversation"),
    "not-applicable"
  );
  assert.equal(
    approve("slack.org.foremanSlack.send_message", {
      current: null,
      initiator: null,
    } as never),
    "not-applicable"
  );
});

test("the customer lane keeps its verified scope and stays out of internal lanes", () => {
  const lane = sessionLane(initiator);
  assert.equal(lane.customer, true);
  assert.equal(lane.broadExecutor, false);
  assert.equal(lane.repository, false);
  assert.equal(repositoryCapabilitiesAvailable(initiator), false);
  assert.equal(canUseInvestigationMemory(initiator), false);
  const prompt = composePrompt(lane);
  assert.match(prompt, WORKSPACE);
  assert.match(prompt, IMMUTABLE);
  assert.match(prompt, QUALIFIED_REPORT);
  assert.match(prompt, COMPLETE_NOW);
  assert.match(prompt, ORGANIZATION_BIND);
  assert.doesNotMatch(prompt, REPOSITORIES);
  assert.doesNotMatch(prompt, MEMORY);
  assert.doesNotMatch(prompt, MODEL_CONTROLS);
});

test("the lane's own ticket reads are bound by the policy, not only by their callers", async () => {
  const scoped = record("call", {
    data: { hasNextPage: false, issues: [] },
    ok: true,
  });
  try {
    for (const [operation, input] of [
      ["list_issues", { limit: 100, query: "other", team: "Engineering Team" }],
      [
        "list_issues",
        { ...finCaseSearch(verifiedFinContext), query: "215475947807357" },
      ],
      ["get_issue", { id: "OPS-1" }],
      ["get_issue", { id: "ENG-13902", includeArchived: true }],
    ] as [string, Record<string, unknown>][]) {
      // biome-ignore lint/performance/noAwaitInLoops: each refusal is checked in order.
      await assert.rejects(
        invokeProvider(ctx(), `linear.org.workspaceLinear.${operation}`, input),
        (error: { code?: string; dispatched?: unknown }) =>
          error.code === "customer_scope_required" &&
          error.dispatched === false,
        operation
      );
    }
    assert.equal(scoped.wires.length, 0, "a refused read never dispatches");
    // The scope's own search and a ticket it names are still reachable.
    await invokeProvider(
      ctx(),
      "linear.org.workspaceLinear.list_issues",
      finCaseSearch(verifiedFinContext) as unknown as Record<string, unknown>
    );
    assert.equal(scoped.wires.length, 1);
  } finally {
    scoped.restore();
  }
});

test("a malformed customer scope remains fail-closed", () => {
  const lane = sessionLane({
    ...initiator,
    attributes: {},
    issuer: FIN_INVESTIGATION_ISSUER,
  });
  assert.equal(lane.customer, true);
  assert.equal(lane.broadExecutor, false);
  assert.equal(lane.repository, false);
  assert.match(lane.instructions, INVALID_SCOPE);
  const ordinary = sessionLane(null);
  assert.equal(ordinary.customer, false);
  assert.equal(ordinary.broadExecutor, true);
  assert.equal(ordinary.repository, true);
});
