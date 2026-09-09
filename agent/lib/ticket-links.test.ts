import assert from "node:assert/strict";
import test from "node:test";
import { wrapLanguageModel } from "ai";
import {
  convertReadableStreamToArray,
  MockLanguageModelV4,
  simulateReadableStream,
} from "ai/test";
import { postSlackReply } from "./slack-post.js";
import { postSupportMessage } from "./support/slack.js";
import { ticketLinkMiddleware } from "./ticket-link-model.js";
import { linkTickets, ticketUrl } from "./ticket-links.js";

const report =
  "Already tried: ENG-13602.\n\nFindings: ENG-13257 and ENG-13602.\n\nNext step: verify `ENG-13257`.";
const ids = ["ENG-13602", "ENG-13257", "ENG-13602", "ENG-13257"];

test("support delivery sends Slack syntax in the final API payload", async () => {
  let sent = false;
  const ts = await postSupportMessage(
    "1788959999.000000",
    linkTickets(report),
    "test-key",
    (method, input) => {
      assert.equal(method, "chat.postMessage");
      assert.equal(input.text, linkTickets(report, "slack"));
      assert.equal(input.thread_ts, "1788959999.000000");
      assert.equal(input.client_msg_id, "test-key");
      sent = true;
      return Promise.resolve({ ok: true as const, ts: "1788959999.000001" });
    }
  );
  assert.equal(sent, true);
  assert.equal(ts, "1788959999.000001");
});

test("every repeated ticket renders as a Slack link, preserving correct existing links", () => {
  const linked = linkTickets(report, "slack");
  const anchors = [...linked.matchAll(/<(https:[^|>]+)\|([^>]+)>/g)];
  assert.deepEqual(
    anchors.map((match) => match[2]),
    ids
  );
  assert.deepEqual(
    anchors.map((match) => match[1]),
    ids.map(ticketUrl)
  );
  assert.equal(linkTickets(linked, "slack"), linked);
  assert.equal(linkTickets(linkTickets(report)), linkTickets(report));
  assert.equal(linkTickets(linkTickets(report), "slack"), linked);
  const existing = `[ENG-13602](${ticketUrl("ENG-13602")}/original-title)`;
  assert.equal(linkTickets(existing), existing);
  assert.equal(
    linkTickets(`URL: ${ticketUrl("ENG-13602")}`),
    `URL: ${ticketUrl("ENG-13602")}`
  );
  assert.equal(
    linkTickets("ENG-TEST someENG-13602 ENG-13602suffix file/ENG-13602"),
    "ENG-TEST someENG-13602 ENG-13602suffix file/ENG-13602"
  );
});

test("existing relative and non-HTTP Markdown links stay intact", () => {
  for (const target of [
    "/issue/ENG-13602",
    "mailto:support@example.com",
    "#ENG-13602",
    "",
  ]) {
    const existing = `[ENG-13602](${target})`;
    assert.equal(linkTickets(existing), existing);
    assert.equal(linkTickets(existing, "slack"), existing);
  }
});

test("Slack chunking keeps expanded ticket links intact at the delivery limit", async () => {
  const chunks: string[] = [];
  await postSlackReply(
    (chunk) => {
      chunks.push(chunk);
      return Promise.resolve();
    },
    `${"a".repeat(11_980)} ENG-13602 then ENG-13257`
  );
  assert.ok(chunks.every((chunk) => chunk.length <= 12_000));
  assert.ok(
    chunks.some((chunk) =>
      chunk.includes(`[ENG-13602](${ticketUrl("ENG-13602")})`)
    )
  );
  assert.ok(
    chunks.some((chunk) =>
      chunk.includes(`[ENG-13257](${ticketUrl("ENG-13257")})`)
    )
  );
});

test("graceful stream closure retains text without a text-end event", async () => {
  const model = wrapLanguageModel({
    middleware: ticketLinkMiddleware,
    model: new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunkDelayInMs: null,
          chunks: [
            { id: "answer", type: "text-start" },
            { delta: "See ENG-13602.", id: "answer", type: "text-delta" },
          ],
          initialDelayInMs: null,
        }),
      },
    }),
  });
  const result = await model.doStream({ prompt: [] });
  assert.deepEqual(await convertReadableStreamToArray(result.stream), [
    { id: "answer", type: "text-start" },
    { delta: linkTickets("See ENG-13602."), id: "answer", type: "text-delta" },
  ]);
});

test("model stream links split tokens before eve HTTP, Slack, Linear and GitHub delivery", async () => {
  const model = wrapLanguageModel({
    middleware: ticketLinkMiddleware,
    model: new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunkDelayInMs: null,
          chunks: [
            { id: "answer", type: "text-start" },
            { delta: "See ENG-", id: "answer", type: "text-delta" },
            { delta: "13602 and ENG-13257.", id: "answer", type: "text-delta" },
            { id: "answer", type: "text-end" },
          ],
          initialDelayInMs: null,
        }),
      },
    }),
  });
  const result = await model.doStream({ prompt: [] });
  const parts = await convertReadableStreamToArray(result.stream);
  assert.deepEqual(parts, [
    { id: "answer", type: "text-start" },
    {
      delta: linkTickets("See ENG-13602 and ENG-13257."),
      id: "answer",
      type: "text-delta",
    },
    { id: "answer", type: "text-end" },
  ]);
});
