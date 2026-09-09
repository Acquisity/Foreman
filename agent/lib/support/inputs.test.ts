import assert from "node:assert/strict";
import { test } from "node:test";
import { supportConfig, supportInitialTimestamp } from "./config.js";
import {
  intercomConversationIds,
  notificationConversation,
} from "./conversation.js";

test("support configuration validates selected IDs and the watermark epoch range", () => {
  const keys = [
    "FOREMAN_SUPPORT_ENABLED",
    "FOREMAN_SUPPORT_HANDOFF_APP_ID",
    "FOREMAN_SUPPORT_SINCE",
    "FOREMAN_SUPPORT_TEST_CONVERSATIONS",
  ];
  const previous = keys.map((key) => [key, process.env[key]] as const);
  try {
    process.env.FOREMAN_SUPPORT_ENABLED = "true";
    process.env.FOREMAN_SUPPORT_HANDOFF_APP_ID = "A123";
    process.env.FOREMAN_SUPPORT_SINCE = "2026-09-09T12:00:00Z";
    process.env.FOREMAN_SUPPORT_TEST_CONVERSATIONS = " 123, 456 , ";
    assert.deepEqual(supportConfig()?.testConversations, ["123", "456"]);
    for (const invalid of [" ", ", ,", "123, bad", "123, 45 6"]) {
      process.env.FOREMAN_SUPPORT_TEST_CONVERSATIONS = invalid;
      assert.throws(() => supportConfig());
    }
    process.env.FOREMAN_SUPPORT_TEST_CONVERSATIONS = "";
    assert.deepEqual(supportConfig()?.testConversations, []);
    delete process.env.FOREMAN_SUPPORT_TEST_CONVERSATIONS;
    assert.deepEqual(supportConfig()?.testConversations, []);
    for (const since of [
      "2000-01-01T00:00:00Z",
      "2001-09-09T01:46:39.999999Z",
      "2001-09-08T21:46:39.999999-04:00",
    ]) {
      process.env.FOREMAN_SUPPORT_SINCE = since;
      assert.throws(
        () => supportConfig(),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes("FOREMAN_SUPPORT_SINCE") &&
          error.message.includes("epoch range")
      );
    }
    for (const since of ["2001-09-09T01:46:40Z", "2001-09-08T21:46:40-04:00"]) {
      process.env.FOREMAN_SUPPORT_SINCE = since;
      assert.equal(supportConfig()?.since, since);
      assert.equal(supportInitialTimestamp(since), "1000000000.000000");
    }
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("initial intake timestamps preserve microseconds and timezone offsets", () => {
  const seconds = Date.parse("2026-09-09T12:00:00Z") / 1000;
  for (const [iso, fraction] of [
    ["2026-09-09T12:00:00Z", "000000"],
    ["2026-09-09T12:00:00.1Z", "100000"],
    ["2026-09-09T12:00:00.123456Z", "123456"],
    ["2026-09-09T08:00:00.123456-04:00", "123456"],
    ["2026-09-09T14:00:00.123456+02:00", "123456"],
    ["2026-09-09T12:00:00.1234567Z", "123456"],
  ]) {
    assert.equal(supportInitialTimestamp(iso), `${seconds}.${fraction}`);
  }
  assert.throws(() => supportInitialTimestamp("not a timestamp"));
});

const inbox = "https://app.intercom.com/a/inbox/ls8uffkp";
const notification = (url: string) =>
  notificationConversation(
    { app_id: "A123", text: `<${url}|Open>`, ts: "1788959233.418909" },
    "A123"
  );

test("one URL cannot hide conflicting conversation references", () => {
  for (const url of [
    `${inbox}/conversation/123?conversation=456`,
    `${inbox}/all?conversation=123&conversation=456`,
    `${inbox}/conversation/123/conversations/456`,
  ]) {
    assert.deepEqual(intercomConversationIds(url), ["123", "456"]);
    assert.equal(notification(url), null);
  }
});

test("repeated matching references and query-only conversation URLs remain usable", () => {
  for (const url of [
    `${inbox}/conversation/123?conversation=123&conversation=123`,
    `${inbox}/conversation/123/conversations/123`,
    `${inbox}/all?conversation=123`,
  ]) {
    assert.deepEqual(intercomConversationIds(url), ["123"]);
    assert.equal(notification(url), "123");
  }
});
