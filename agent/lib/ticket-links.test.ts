import assert from "node:assert/strict";
import test from "node:test";
import { wrapLanguageModel } from "ai";
import {
  convertReadableStreamToArray,
  MockLanguageModelV4,
  simulateReadableStream,
} from "ai/test";
import { postSlackReply, splitSlackReply } from "./slack-post.js";
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

test("Slack conversion preserves nested URL parentheses and escapes label delimiters", () => {
  const url = "https://example.com/help_(topic_(detail))";
  const markdown = `[A < B & C > D](${url})`;
  const slack = `<${url}|A &lt; B &amp; C &gt; D>`;
  assert.equal(linkTickets(markdown), markdown);
  assert.equal(linkTickets(markdown, "slack"), slack);
  assert.equal(linkTickets(slack, "slack"), slack);
  assert.equal(
    linkTickets(`[ENG-13602](<${url}>)`, "slack"),
    `<${url}|ENG-13602>`
  );
  const pipeLabel = `[A | B](${url})`;
  assert.equal(linkTickets(pipeLabel, "slack"), pipeLabel);
});

test("over-limit links are hard-cut while retaining all text and the post limit", () => {
  const text = `[ENG-13602](https://example.com/${"a".repeat(150)})`;
  const chunks = splitSlackReply(text, 100);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => chunk.length <= 100));
});

test("chunk boundaries preserve the full closing delimiter of nested links", () => {
  const link = "[a](https://example.com/(x_(y)))";
  const prefix = "z".repeat(100 - link.length + 1);
  assert.deepEqual(splitSlackReply(`${prefix}${link} tail`, 100), [
    prefix,
    `${link} tail`,
  ]);
});

test("malformed same-line link prefixes leave later prose ticket references linkable", () => {
  const prefix = "[label](".repeat(2000);
  assert.equal(
    linkTickets(`${prefix} ENG-13602`),
    `${prefix} ${linkTickets("ENG-13602")}`
  );
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
  const providerMetadata = { gateway: { trace: "delta-trace" } };
  const model = wrapLanguageModel({
    middleware: ticketLinkMiddleware,
    model: new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunkDelayInMs: null,
          chunks: [
            { id: "answer", type: "text-start" },
            {
              delta: "See ENG-",
              id: "answer",
              providerMetadata,
              type: "text-delta",
            },
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
    { delta: "", id: "answer", providerMetadata, type: "text-delta" },
    {
      delta: linkTickets("See ENG-13602 and ENG-13257."),
      id: "answer",
      type: "text-delta",
    },
    { id: "answer", type: "text-end" },
  ]);
});

test("buffered text arrives before finish when text-end is missing", async () => {
  const finish = {
    finishReason: { raw: "stop", unified: "stop" as const },
    type: "finish" as const,
    usage: {
      inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
      outputTokens: { reasoning: 0, text: 1, total: 1 },
    },
  };
  const model = wrapLanguageModel({
    middleware: ticketLinkMiddleware,
    model: new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunkDelayInMs: null,
          chunks: [
            { id: "answer", type: "text-start" },
            { delta: "ENG-13602", id: "answer", type: "text-delta" },
            finish,
          ],
          initialDelayInMs: null,
        }),
      },
    }),
  });
  const result = await model.doStream({ prompt: [] });
  assert.deepEqual(await convertReadableStreamToArray(result.stream), [
    { id: "answer", type: "text-start" },
    { delta: linkTickets("ENG-13602"), id: "answer", type: "text-delta" },
    finish,
  ]);
});
