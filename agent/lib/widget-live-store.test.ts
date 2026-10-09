import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { test } from "node:test";
import type { RouteHandlerArgs, Session } from "eve/channels";
import { verifiedWidgetContext as fixture } from "./widget.fixture.js";
import { verifyWidgetContext } from "./widget-context.js";
import type { WidgetFindings } from "./widget-findings.js";
import {
  defaultWidgetDependencies,
  failWidgetRun,
  receiveWidgetMessage,
  type WidgetDependencies,
} from "./widget-investigation.js";
import { liveDependencies, liveRunStore } from "./widget-live-store.js";

const secret = "s".repeat(40);
const findings: WidgetFindings = {
  confidence: "high",
  facts: [],
  needsHuman: false,
  recommendation: "Check the inbox.",
  report: "The inbox is active.",
};

test("full live staff lifecycle persists locally without SQL or external writes", async (t) => {
  const directory = `.eve/widget-live/test-${randomUUID()}`;
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { force: true, recursive: true }));
  for (const [key, value] of Object.entries({
    FOREMAN_DIAGNOSTICS_SECRET: secret,
    SUPPORT_CHAT_ENABLED: "true",
    WIDGET_LIVE: "1",
  })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = previous;
      }
    });
  }
  let sqlCalls = 0;
  let externalCalls = 0;
  t.mock.method(globalThis, "fetch", () => {
    externalCalls += 1;
    throw new Error("unexpected external transport");
  });
  const sql = () => {
    sqlCalls += 1;
    throw new Error("unexpected SQL transport");
  };
  const base: WidgetDependencies = {
    ...defaultWidgetDependencies,
    attach: sql,
    cancel: sql,
    changeRequested: () => Promise.resolve(false),
    claim: sql,
    claimFinish: sql,
    complete: sql,
    expire: sql,
    expireAll: sql,
    extract: () => Promise.resolve(findings),
    gate: () =>
      Promise.resolve({
        decision: "allow",
        findings,
        message: "The inbox is active.",
        reason: "in scope",
      }),
    history: sql,
    latestScope: sql,
    plan: () => Promise.resolve(["inboxes"]),
    progress: sql,
    read: sql,
    requestRecording: sql,
    verifyAccess: () =>
      Promise.resolve({
        domains: new Set(),
        emails: new Set(),
        slugs: new Set(),
        uuids: new Set(),
      }),
  };
  const deps = liveDependencies(base, directory);
  const scope = { ...fixture, source: "inbox" as const };
  const token = Buffer.from(
    JSON.stringify({ scope, sentAt: "2026-10-01T12:00:00Z" })
  ).toString("base64url");
  const request = (body: object) =>
    new Request("http://localhost/internal/widget/message", {
      body: JSON.stringify({
        conversation_id: scope.conversationId,
        organization_id: scope.organizationId,
        staff: true,
        ...body,
      }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-acquisity-service-secret": secret,
      },
      method: "POST",
    });
  const events = [
    {
      data: {
        actions: [
          {
            callId: "read-1",
            kind: "tool-call",
            toolName: "widget_inbox_health",
          },
        ],
      },
      type: "actions.requested",
    },
    {
      data: {
        result: {
          callId: "read-1",
          output: { available: true },
          toolName: "widget_inbox_health",
        },
        status: "completed",
      },
      type: "action.result",
    },
    {
      data: { finishReason: "stop", message: "The inbox is active." },
      type: "message.completed",
    },
    { type: "session.completed" },
  ];
  const backgrounds: Promise<unknown>[] = [];
  const handlers = {
    from: () => ({
      send: () =>
        Promise.resolve({
          getEventStream: () =>
            Promise.resolve(
              new ReadableStream({
                start(controller) {
                  for (const event of events) {
                    controller.enqueue(event);
                  }
                  controller.close();
                },
              })
            ),
          id: "live-test-session",
        } as unknown as Session),
    }),
    waitUntil: (promise: Promise<unknown>) => {
      backgrounds.push(promise);
    },
  } as unknown as Pick<RouteHandlerArgs, "from" | "waitUntil">;
  const response = await receiveWidgetMessage(
    request({ message_id: randomUUID(), question: "Why did sending stop?" }),
    handlers,
    1000,
    verifyWidgetContext,
    deps
  );
  assert.equal(response.status, 200);
  await Promise.all(backgrounds);
  const result = await response.json();
  const run = await deps.read(result.run_id);
  assert.equal(run.scope.source, "inbox");
  assert.equal(run.scope.liveAsOf, "2026-10-01T12:00:00Z");
  assert.equal(run.outcome?.status, "completed");
  assert.equal(run.progress?.stage, "preparing");
  assert.equal(
    (await liveRunStore(directory).read(run.id)).outcome?.message,
    "The inbox is active."
  );
  const poll = await receiveWidgetMessage(
    request({ action: "result", run_id: run.id }),
    handlers,
    1,
    verifyWidgetContext,
    liveDependencies(base, directory)
  );
  assert.equal((await poll.json()).status, "completed");
  // Both root terminal failure and a session-start failure use the selected store.
  const failed = await deps.claim(
    run.scope,
    randomUUID(),
    "A second local test."
  );
  await deps.attach(failed.run.id, "failed-test-session", 0);
  await failWidgetRun(failed.run.id, "failed-test-session", deps);
  assert.equal((await deps.read(failed.run.id)).outcome?.status, "failed");
  const refused = await receiveWidgetMessage(
    request({ message_id: randomUUID(), question: "A third local test." }),
    {
      ...handlers,
      from: () => ({ send: () => Promise.reject(new Error("session failed")) }),
    } as unknown as Pick<RouteHandlerArgs, "from" | "waitUntil">,
    1,
    verifyWidgetContext,
    deps
  );
  assert.equal(refused.status, 503);
  const persisted = JSON.parse(
    await readFile(`${directory}/store.json`, "utf8")
  );
  assert.equal(persisted.length, 3);
  assert.equal(persisted[2].run.outcome.status, "failed");
  assert.equal(sqlCalls, 0);
  assert.equal(externalCalls, 0);
  Reflect.deleteProperty(process.env, "WIDGET_LIVE");
  assert.equal(liveDependencies(base, directory), base);
});
