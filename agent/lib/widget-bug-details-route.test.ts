import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import type { RouteHandlerArgs } from "eve/channels";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import type { BugDetailsResponse } from "./widget-bug-details.js";
import {
  receiveWidgetMessage,
  type WidgetDependencies,
} from "./widget-investigation.js";

const SERVICE_SECRET = "s".repeat(40);

function enabled(t: TestContext) {
  for (const [key, value] of [
    ["SUPPORT_CHAT_ENABLED", "true"],
    ["FOREMAN_DIAGNOSTICS_SECRET", SERVICE_SECRET],
  ] as const) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    });
  }
}

/** Only what a bug_details turn may touch; any other dependency fails the test. */
const only = (deps: Partial<WidgetDependencies>) =>
  new Proxy(deps, {
    get: (target, key: string) =>
      key in target
        ? target[key as keyof WidgetDependencies]
        : () => assert.fail(`a bug_details turn must not call ${key}`),
  }) as WidgetDependencies;

const request = (body: Record<string, unknown>) =>
  new Request("https://foreman.example/internal/widget/message", {
    body: JSON.stringify({
      conversation_id: scope.conversationId,
      message_id: crypto.randomUUID(),
      mode: "bug_details",
      organization_id: scope.organizationId,
      question: "my campaign isn't working",
      ...body,
    }),
    headers: {
      authorization: "Bearer signed.user.identity",
      "content-type": "application/json",
      "x-acquisity-service-secret": SERVICE_SECRET,
    },
    method: "POST",
  });

const noWork = (): Pick<RouteHandlerArgs, "from" | "waitUntil"> => ({
  from: () => assert.fail("must not start a session"),
  waitUntil: () => assert.fail("must not start background work"),
});
const verify = () => Promise.resolve(scope);

const asked: BugDetailsResponse = {
  bug_details: "ask",
  decision: "allow",
  message: "What were you trying to do when this happened?",
  run_id: "11111111-1111-4111-8111-111111111111",
  status: "completed",
};

test("a bug_details turn answers inline from the follow-up check and never claims a run", async (t) => {
  enabled(t);
  const seen: { asked: string[]; conversation: string }[] = [];
  const response = await receiveWidgetMessage(
    request({
      history: [
        { role: "customer", text: "I found a bug" },
        { role: "assistant", text: "Sorry about that. What happened?" },
      ],
    }),
    noWork(),
    1,
    verify,
    only({
      bugDetails: (input) => {
        seen.push(input);
        return Promise.resolve(asked);
      },
      latestScope: () => Promise.resolve(null),
    })
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), asked);
  assert.ok(seen[0]?.conversation.includes("my campaign isn't working"));
  assert.ok(seen[0]?.conversation.includes("I found a bug"));
  assert.deepEqual(seen[0]?.asked, ["Sorry about that. What happened?"]);
});

test("a failed follow-up check answers 503, which Acquisity treats as a pass", async (t) => {
  enabled(t);
  const warned: string[] = [];
  t.mock.method(console, "warn", (line: string) => warned.push(line));
  const response = await receiveWidgetMessage(
    request({}),
    noWork(),
    1,
    verify,
    only({
      bugDetails: () => Promise.reject(new Error("no_key")),
      latestScope: () => Promise.resolve(null),
    })
  );
  assert.equal(response.status, 503);
  assert.equal(warned.length, 2);
});

test("a bug_details turn from a changed user or role is refused before the follow-up check", async (t) => {
  enabled(t);
  const response = await receiveWidgetMessage(
    request({}),
    noWork(),
    1,
    verify,
    only({
      bugDetails: () => assert.fail("must not run the follow-up check"),
      latestScope: () =>
        Promise.resolve({ ...scope, userId: crypto.randomUUID() }),
    })
  );
  assert.equal(response.status, 403);
});
