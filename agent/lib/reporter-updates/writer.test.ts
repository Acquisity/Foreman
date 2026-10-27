import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import type { OpsFields } from "../ops-log.js";
import {
  NO_REPLY,
  reporterWriter,
  type WriterTask,
  writerPrompt,
} from "./writer.js";

const answer = (text: string) =>
  new MockLanguageModelV4({
    doGenerate: {
      content: [{ text, type: "text" }],
      finishReason: { raw: "stop", unified: "stop" },
      usage: {
        inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
        outputTokens: { reasoning: 0, text: 4, total: 4 },
      },
      warnings: [],
    },
  });

const TASK: WriterTask = {
  description: "Threads show a spinner forever.",
  kind: "received",
  title: "Email threads never load",
};

const recorder = () => {
  const events: { event: string; fields: OpsFields }[] = [];
  return {
    events,
    log: (event: string, fields: OpsFields) => {
      events.push({ event, fields });
    },
  };
};

describe("reporterWriter", () => {
  it("returns the phrase from a reply that matches the schema", async () => {
    const write = reporterWriter(
      answer(
        JSON.stringify({
          asDesigned: null,
          steps: null,
          what: "why your email threads won't load",
        })
      )
    );
    assert.deepEqual(await write(TASK), {
      asDesigned: null,
      steps: null,
      what: "why your email threads won't load",
    });
  });

  it("returns no phrase and logs when the reply does not match the schema", async () => {
    const { events, log } = recorder();
    const write = reporterWriter(
      answer(JSON.stringify({ what: 7 })),
      1000,
      log
    );
    assert.deepEqual(await write(TASK), NO_REPLY);
    assert.equal(events[0]?.event, "reporter.update.writer_failed");
    assert.equal(events[0]?.fields.decision, "received");
  });

  it("returns no phrase when the call fails", async () => {
    const { events, log } = recorder();
    const write = reporterWriter(
      new MockLanguageModelV4({
        doGenerate: () => Promise.reject(new Error("proxy down")),
      }),
      1000,
      log
    );
    assert.deepEqual(await write(TASK), NO_REPLY);
    assert.equal(events.length, 1);
  });

  it("returns no phrase when the call runs past its timeout", async () => {
    const { log } = recorder();
    const write = reporterWriter(
      new MockLanguageModelV4({
        doGenerate: ({ abortSignal }) =>
          new Promise((_, reject) => {
            abortSignal?.addEventListener("abort", () =>
              reject(abortSignal.reason)
            );
          }),
      }),
      20,
      log
    );
    assert.deepEqual(await write(TASK), NO_REPLY);
  });
});

describe("writerPrompt", () => {
  it("gives the live task the change description and asks for steps naming the screen", () => {
    const prompt = writerPrompt({
      description: "Reps want to email from the dialler.",
      kind: "live",
      pull: "## Solution\nAdd Email to the existing next-step controls.",
      title: "Email from Power Dialer",
    });
    assert.ok(prompt.includes("Add Email to the existing next-step controls."));
    assert.ok(prompt.includes("naming the button, page or menu"));
  });

  it("asks the done task to say null unless a person describes a change", () => {
    const prompt = writerPrompt({
      comments: ["Could not reproduce."],
      kind: "done",
      title: "Notes not saving",
    });
    assert.ok(prompt.includes("- Could not reproduce."));
    assert.ok(prompt.includes("When in doubt, use null."));
  });

  it("asks the reason task to judge whether the product works as designed", () => {
    const prompt = writerPrompt({
      comments: ["Expected behaviour."],
      kind: "reason",
      title: "Export stops at a year",
    });
    assert.ok(prompt.includes("Set asDesigned to true when"));
  });

  it("never asks for owners, developers or engineering words", () => {
    assert.ok(writerPrompt(TASK).includes("Never mention developers, owners"));
  });
});
