import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { verifiedWidgetContext } from "./widget.fixture.js";
import { verifyWidgetContext } from "./widget-context.js";

const origin = "https://pr-13999-acquisity.vercel.app";
const userToken = "signed.user.identity";
const { conversationId, organizationId } = verifiedWidgetContext;
const appContext = {
  intercomAppId: "local-dev-placeholder",
  organizationId,
  organizationName: verifiedWidgetContext.organizationName,
  organizationSlug: verifiedWidgetContext.organizationSlug,
  partnerId: verifiedWidgetContext.partnerId,
  role: "owner",
  userId: verifiedWidgetContext.userId,
  verifiedAt: verifiedWidgetContext.verifiedAt,
};

function configure(context: TestContext) {
  const previous = process.env.ACQUISITY_FIN_ORIGIN;
  process.env.ACQUISITY_FIN_ORIGIN = origin;
  context.after(() => {
    if (previous === undefined) {
      delete process.env.ACQUISITY_FIN_ORIGIN;
    } else {
      process.env.ACQUISITY_FIN_ORIGIN = previous;
    }
  });
}

const requester = (response: Response) => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const request = ((url, init) => {
    requests.push({ init, url: String(url) });
    return Promise.resolve(response);
  }) satisfies typeof fetch;
  return { request, requests };
};

test("verifies the organization with the app and returns only the widget scope", async (context) => {
  configure(context);
  const { request, requests } = requester(Response.json(appContext));
  const result = await verifyWidgetContext(
    { conversationId, organizationId, userToken },
    request
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${origin}/api/internal/foreman/context`);
  const headers = new Headers(requests[0].init?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${userToken}`);
  assert.equal(headers.get("x-partner-id"), verifiedWidgetContext.partnerId);
  // The exact chat is named, so the app never resolves scope from another one.
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
    organizationId,
    widgetConversationId: conversationId,
  });
  assert.deepEqual(result, verifiedWidgetContext);
  assert.ok(Object.isFrozen(result));
  assert.equal("intercomAppId" in result, false);
});

test("rejects a denied, mismatched, or malformed verification", async (context) => {
  configure(context);
  for (const response of [
    Response.json({ error: "denied" }, { status: 403 }),
    Response.json({ ...appContext, organizationId: conversationId }),
    Response.json({ ...appContext, role: "guest" }),
    new Response("not json"),
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: each response is one rejection case.
    await assert.rejects(
      verifyWidgetContext(
        { conversationId, organizationId, userToken },
        requester(response).request
      )
    );
  }
});

test("caller-authored identifiers never reach the app", async (context) => {
  configure(context);
  const { request, requests } = requester(Response.json(appContext));
  await assert.rejects(
    verifyWidgetContext(
      { conversationId: "../other", organizationId, userToken },
      request
    )
  );
  await assert.rejects(
    verifyWidgetContext(
      { conversationId, organizationId, userToken: "bad token" },
      request
    )
  );
  assert.equal(requests.length, 0);
});
