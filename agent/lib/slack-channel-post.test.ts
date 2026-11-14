import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { postSlackChannelMessage } from "./slack-channel-post.js";

const realFetch = globalThis.fetch;
const token = () => Promise.resolve("xoxb-test");

const respondWith = (status: number, body: string, sent: URLSearchParams[]) => {
  globalThis.fetch = ((_url: string, init: { body: URLSearchParams }) => {
    sent.push(init.body);
    return Promise.resolve(new Response(body, { status }));
  }) as unknown as typeof fetch;
};

describe("postSlackChannelMessage", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("posts the text into the channel and resolves when Slack accepts it", async () => {
    const sent: URLSearchParams[] = [];
    respondWith(200, '{"ok":true}', sent);
    await postSlackChannelMessage("C123", { text: "hello" }, token);
    assert.equal(sent[0]?.get("channel"), "C123");
    assert.equal(sent[0]?.get("text"), "hello");
    assert.equal(sent[0]?.get("blocks"), null);
  });

  for (const [name, status, body] of [
    ["a non-OK status", 500, '{"ok":true}'],
    ["ok: false", 200, '{"ok":false,"error":"channel_not_found"}'],
    ["a non-JSON body", 200, "<html>gateway</html>"],
    ["a null body", 200, "null"],
  ] as const) {
    test(`throws the fixed error, never the body, on ${name}`, async () => {
      respondWith(status, body, []);
      await assert.rejects(
        postSlackChannelMessage("C123", { text: "hello" }, token),
        { message: "Slack refused the channel message." }
      );
    });
  }
});
