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

function setEnv(context: TestContext, name: string, value?: string) {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  context.after(() => {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  });
}

// Every test here exercises the app path, so an inherited replay flag must not divert it.
function configure(context: TestContext) {
  setEnv(context, "ACQUISITY_ORIGIN", origin);
  setEnv(context, "WIDGET_REPLAY");
  setEnv(context, "WIDGET_REPLAY_CASE");
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

test("a teammate's request names the conversation for the app and is scoped as an inbox run", async (context) => {
  configure(context);
  const { request, requests } = requester(Response.json(appContext));
  const result = await verifyWidgetContext(
    { conversationId, organizationId, staff: true, userToken },
    request
  );
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
    conversationId,
    organizationId,
  });
  assert.equal(result.source, "inbox");
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

test("the replay case selector is ignored when replay is disabled", async (context) => {
  configure(context);
  const { request, requests } = requester(
    Response.json({ ...appContext, replayCaseId: "local-widget-smoke" })
  );
  const scope = await verifyWidgetContext(
    { conversationId, organizationId, replayCaseId: "../../secret", userToken },
    request
  );
  assert.equal(requests.length, 1);
  assert.equal(scope.replayCaseId, undefined);
  assert.equal(
    "replayCaseId" in JSON.parse(String(requests[0].init?.body)),
    false
  );
});

const officeHours = {
  customerTimeZone: "America/New_York",
  enabled: true,
  nextOpenAt: "2026-10-19T13:00:00.000Z",
  nextOpenText: "Monday, Oct 19 at 9:00 AM EDT",
  open: false,
  replyTimeMinutes: 20,
  replyTimeText: "20 minutes",
  showReplyTime: true,
  timeZone: "America/New_York",
};

test("the app's office hours ride on the verified scope; absent or malformed hours read as absent", async (context) => {
  configure(context);
  const verify = (body: object) =>
    verifyWidgetContext(
      { conversationId, organizationId, userToken },
      requester(Response.json(body)).request
    );
  assert.deepEqual(
    (await verify({ ...appContext, officeHours })).officeHours,
    officeHours
  );
  assert.equal("officeHours" in (await verify(appContext)), false);
  for (const malformed of [
    { ...officeHours, open: "no" },
    { ...officeHours, extra: true },
    { ...officeHours, nextOpenText: "<b>soon</b>" },
    "closed",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: each body is one case.
    const scope = await verify({ ...appContext, officeHours: malformed });
    assert.equal("officeHours" in scope, false);
    assert.equal(scope.organizationId, organizationId);
  }
});

test("the app's schedule fields ride on the office hours; a malformed one reads as absent and the rest stand", async (context) => {
  configure(context);
  const verify = (body: object) =>
    verifyWidgetContext(
      { conversationId, organizationId, userToken },
      requester(Response.json(body)).request
    );
  const schedule = {
    hoursText: ["Monday–Friday: 9:00 AM–5:00 PM"],
    timeZoneName: "Eastern Time",
    upcomingClosures: [
      { date: "2026-11-26", hours: "Closed all day", label: "New Year's Day" },
    ],
  };
  assert.deepEqual(
    (
      await verify({
        ...appContext,
        officeHours: { ...officeHours, ...schedule },
      })
    ).officeHours,
    { ...officeHours, ...schedule }
  );
  for (const malformed of [
    { hoursText: "Monday–Friday: 9–5" },
    { hoursText: ["<b>always</b>"] },
    { timeZoneName: 5 },
    { upcomingClosures: [{ date: "2026-11-26", hours: "Closed all day" }] },
    { upcomingClosures: [{ ...schedule.upcomingClosures[0], extra: 1 }] },
    {
      upcomingClosures: [
        { ...schedule.upcomingClosures[0], date: "2026-02-30" },
      ],
    },
  ]) {
    const hours = { ...officeHours, ...schedule, ...malformed };
    // biome-ignore lint/performance/noAwaitInLoops: each body is one case.
    const verified = (await verify({ ...appContext, officeHours: hours }))
      .officeHours;
    assert.equal(verified?.open, false);
    const [key] = Object.keys(malformed) as (keyof typeof schedule)[];
    assert.equal(verified?.[key], undefined);
  }
});

const timeline = {
  callSteps: [
    {
      at: "2026-11-05T09:30:00.000Z",
      elapsedMs: 6100,
      step: "sdk_connect",
      stepMs: 4200,
      traceUrl:
        "https://app.axiom.co/acquisity-3nbk/trace?traceId=0af7651916cd43dd8448eb211c80319c",
    },
  ],
  networkTypes: ["3g"],
  padding: "p".repeat(15_000),
};

test("the user timeline is asked for only when wanted, read past the scope's size limit, and kept out of the scope", async (context) => {
  configure(context);
  const seen: Record<string, unknown>[] = [];
  const asked = requester(Response.json({ ...appContext, timeline }));
  const scope = await verifyWidgetContext(
    {
      conversationId,
      onTimeline: (value) => seen.push(value),
      organizationId,
      timeline: true,
      userToken,
    },
    asked.request
  );
  assert.equal(
    new Headers(asked.requests[0].init?.headers).get("x-foreman-timeline"),
    "1"
  );
  assert.deepEqual(seen, [timeline]);
  assert.deepEqual(scope, verifiedWidgetContext);
  assert.equal("timeline" in scope, false);

  const plain = requester(Response.json(appContext));
  await verifyWidgetContext(
    { conversationId, organizationId, userToken },
    plain.request
  );
  assert.equal(
    new Headers(plain.requests[0].init?.headers).has("x-foreman-timeline"),
    false
  );

  await assert.rejects(
    verifyWidgetContext(
      { conversationId, organizationId, userToken },
      requester(Response.json({ ...appContext, timeline })).request
    )
  );
});

test("an app without the timeline, or a malformed one, still verifies with no timeline", async (context) => {
  configure(context);
  for (const body of [
    appContext,
    { ...appContext, timeline: "slow" },
    { ...appContext, timeline: [1, 2] },
    { ...appContext, timeline: null },
  ]) {
    const seen: unknown[] = [];
    // biome-ignore lint/performance/noAwaitInLoops: each body is one case.
    const scope = await verifyWidgetContext(
      {
        conversationId,
        onTimeline: (value) => seen.push(value),
        organizationId,
        timeline: true,
        userToken,
      },
      requester(Response.json(body)).request
    );
    assert.deepEqual(scope, verifiedWidgetContext);
    assert.deepEqual(seen, []);
  }
});

test("a timeline response past the larger limit is refused", async (context) => {
  configure(context);
  await assert.rejects(
    verifyWidgetContext(
      { conversationId, organizationId, timeline: true, userToken },
      requester(
        Response.json({
          ...appContext,
          timeline: { padding: "p".repeat(40_000) },
        })
      ).request
    )
  );
});
