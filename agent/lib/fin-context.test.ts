import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { readFinIntercom } from "./executor/dispatch.js";
import { verifyFinContext } from "./fin-context.js";

const origin = "https://pr-13763-acquisity.vercel.app";
const userId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const conversationId = "215475919123456";
const id = "contact-123";
const userToken = "signed.user.identity";
const input = { conversationId, userToken };
const appContext = {
  intercomAppId: "ls8uffkp",
  organizationId,
  organizationName: "Diamond",
  organizationSlug: "diamond-workspace",
  partnerId: "00000000-0000-0000-0000-000000000001",
  role: "admin",
  userId,
  verifiedAt: "2026-09-15T12:00:00.000Z",
};
const conversation = {
  contacts: { contacts: [{ id }], total_count: 1 },
  id: conversationId,
  source: {
    author: { id, type: "user" },
    url: `${origin}/dashboard/diamond-workspace/settings`,
  },
};
const contact = { external_id: userId, id, workspace_id: "ls8uffkp" };

function configure(context: TestContext, value: string | undefined = origin) {
  const previous = process.env.ACQUISITY_FIN_ORIGIN;
  if (value === undefined) {
    delete process.env.ACQUISITY_FIN_ORIGIN;
  } else {
    process.env.ACQUISITY_FIN_ORIGIN = value;
  }
  context.after(() => {
    if (previous === undefined) {
      delete process.env.ACQUISITY_FIN_ORIGIN;
    } else {
      process.env.ACQUISITY_FIN_ORIGIN = previous;
    }
  });
}

function dependencies(
  overrides: {
    conversation?: unknown;
    contact?: unknown;
    response?: Response;
  } = {}
) {
  const calls: { operation: string; id: string }[] = [];
  const requests: { url: string; init?: RequestInit }[] = [];
  return {
    calls,
    readIntercom: ((operation, requestedId) => {
      calls.push({ id: requestedId, operation });
      return Promise.resolve({
        content: [
          {
            text: JSON.stringify(
              operation === "get_conversation"
                ? (overrides.conversation ?? conversation)
                : (overrides.contact ?? contact)
            ),
            type: "text",
          },
        ],
      });
    }) satisfies typeof readFinIntercom,
    request: ((url, init) => {
      requests.push({ init, url: String(url) });
      return Promise.resolve(overrides.response ?? Response.json(appContext));
    }) satisfies typeof fetch,
    requests,
  };
}

for (const authorType of ["lead", "contact"]) {
  test(`native ${authorType} still requires matching app-verified identity`, async (t) => {
    configure(t);
    const native = {
      ...conversation,
      source: { ...conversation.source, author: { id, type: authorType } },
    };
    assert.equal(
      (await verifyFinContext(input, dependencies({ conversation: native })))
        .userId,
      userId
    );
    await assert.rejects(
      verifyFinContext(
        input,
        dependencies({
          contact: {
            ...contact,
            external_id: "22222222-2222-4222-8222-222222222222",
          },
          conversation: native,
        })
      )
    );
  });
}

test("verifies native conversation scope and returns only immutable app-verified identity", async (context) => {
  configure(context);
  const deps = dependencies({
    contact: { ...contact, custom_attributes: { workspace: "Demo" } },
  });
  const result = await verifyFinContext(input, deps);
  assert.deepEqual(deps.calls, [
    { id: conversationId, operation: "get_conversation" },
    { id, operation: "get_contact" },
  ]);
  assert.equal(deps.requests.length, 1);
  const [sent] = deps.requests;
  assert.equal(sent.url, `${origin}/api/internal/foreman/context`);
  assert.equal(
    sent.init?.body,
    JSON.stringify({ organizationSlug: "diamond-workspace" })
  );
  assert.equal(
    new Headers(sent.init?.headers).get("authorization"),
    `Bearer ${userToken}`
  );
  assert.equal(sent.init?.redirect, "error");
  assert.ok(sent.init?.signal instanceof AbortSignal);
  assert.deepEqual(result, {
    ...appContext,
    contactId: id,
    conversationId,
    origin,
  });
  assert.ok(Object.isFrozen(result));
  assert.equal(JSON.stringify(result).includes(userToken), false);
  assert.equal(JSON.stringify(deps.calls).includes(userToken), false);
});

for (const value of [
  "",
  "http://app.acquisity.ai",
  `${origin}/wrong`,
  `https://user:pass@${new URL(origin).host}`,
  `${origin}?next=other`,
]) {
  test(`rejects invalid configured origin ${value}`, async (context) => {
    configure(context, value);
    const deps = dependencies();
    await assert.rejects(verifyFinContext(input, deps));
    assert.equal(deps.calls.length, 0);
    assert.equal(deps.requests.length, 0);
  });
}

for (const url of [
  "https://app.acquisity.ai/dashboard/diamond-workspace",
  `${origin}.evil.test/dashboard/diamond-workspace`,
  `${origin}/dashboard`,
  `${origin}/profile`,
  `${origin}/dashboard/diamond%2fworkspace`,
  `https://user:pass@${new URL(origin).host}/dashboard/diamond-workspace`,
  null,
]) {
  test(`rejects absent or mismatched native workspace source ${url}`, async (context) => {
    configure(context);
    const deps = dependencies({
      conversation: {
        ...conversation,
        source: { ...conversation.source, url },
      },
    });
    await assert.rejects(verifyFinContext(input, deps));
    assert.equal(deps.calls.length, 1);
    assert.equal(deps.requests.length, 0);
  });
}

for (const invalid of [
  { ...conversation, id: "999" },
  { ...conversation, contacts: { contacts: [{ id }, { id: "other" }] } },
  { ...conversation, contacts: { contacts: [{ id }], total_count: 2 } },
]) {
  test("rejects a mismatched or ambiguous Intercom conversation before app verification", async (context) => {
    configure(context);
    const deps = dependencies({ conversation: invalid });
    await assert.rejects(verifyFinContext(input, deps));
    assert.equal(deps.calls.length, 1);
    assert.equal(deps.requests.length, 0);
  });
}

test("rejects a different contact returned by Intercom", async (context) => {
  configure(context);
  const deps = dependencies({ contact: { ...contact, id: "other" } });
  await assert.rejects(verifyFinContext(input, deps));
  assert.equal(deps.requests.length, 0);
});

for (const author of [
  { id: "other-contact", type: "user" },
  { id, type: "admin" },
]) {
  test("rejects a source author other than the sole user contact", async (context) => {
    configure(context);
    const deps = dependencies({
      conversation: {
        ...conversation,
        source: { ...conversation.source, author },
      },
    });
    await assert.rejects(verifyFinContext(input, deps));
    assert.equal(deps.calls.length, 1);
    assert.equal(deps.requests.length, 0);
  });
}

test("rejects an Intercom contact from a different workspace", async (context) => {
  configure(context);
  const deps = dependencies({
    contact: { ...contact, workspace_id: "another-app" },
  });
  await assert.rejects(verifyFinContext(input, deps));
  assert.equal(deps.calls.length, 2);
  assert.equal(deps.requests.length, 0);
});

for (const status of [201, 301, 401, 403, 500]) {
  test(`never treats app status ${status} as verified identity`, async (context) => {
    configure(context);
    await assert.rejects(
      verifyFinContext(
        input,
        dependencies({ response: Response.json(appContext, { status }) })
      )
    );
  });
}

for (const changed of [
  { userId: "33333333-3333-4333-8333-333333333333" },
  { organizationSlug: "demo-workspace" },
  { role: "member" },
  { intercomAppId: "different-app" },
  { partnerId: "33333333-3333-4333-8333-333333333333" },
  { token: userToken },
]) {
  test("rejects inconsistent or overbroad app identity responses", async (context) => {
    configure(context);
    await assert.rejects(
      verifyFinContext(
        input,
        dependencies({ response: Response.json({ ...appContext, ...changed }) })
      )
    );
  });
}

test("bounds streamed app responses without a content-length header", async (context) => {
  configure(context);
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
      start(controller) {
        controller.enqueue(new Uint8Array(4097));
      },
    })
  );
  await assert.rejects(verifyFinContext(input, dependencies({ response })));
  assert.equal(cancelled, true);
});

test("cancels an app body that stalls after response headers", async (context) => {
  configure(context);
  const controller = new AbortController();
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    })
  );
  const promise = verifyFinContext(
    { ...input, signal: controller.signal },
    dependencies({ response })
  );
  const timeout = setTimeout(() => controller.abort(), 10);
  try {
    await assert.rejects(promise);
    assert.equal(cancelled, true);
  } finally {
    clearTimeout(timeout);
  }
});

test("fixed route reader refuses arbitrary operations and identifiers before authorization", async () => {
  await assert.rejects(
    readFinIntercom("search" as "get_contact", id, AbortSignal.timeout(1000))
  );
  await assert.rejects(
    readFinIntercom("get_contact", "../other", AbortSignal.timeout(1000))
  );
});
