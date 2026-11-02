import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

  it("keeps the received prompt and three-field schema identical to main", async () => {
    const main = JSON.parse(
      readFileSync(
        new URL("./fixtures/received-writer-main.json", import.meta.url),
        "utf8"
      )
    );
    const model = answer(
      JSON.stringify({
        asDesigned: null,
        steps: null,
        what: "why your email threads won't load",
      })
    );
    const result = await reporterWriter(model)(TASK);
    assert.equal(result.what, "why your email threads won't load");
    assert.equal(writerPrompt(TASK), main.prompt);
    assert.deepEqual(
      model.doGenerateCalls[0]?.responseFormat,
      main.responseFormat
    );
  });

  it("returns the verdict outcome, and no reply for an outcome it does not know", async () => {
    const reply = (verdict: string) =>
      JSON.stringify({ asDesigned: null, steps: null, verdict, what: null });
    const task: WriterTask = {
      kind: "verdict",
      reply: "I fixed it and the change is open for review.",
      title: "Webhook guide link is a 404",
    };
    assert.equal(
      (await reporterWriter(answer(reply("fix_in_review")))(task)).verdict,
      "fix_in_review"
    );
    const { events, log } = recorder();
    assert.deepEqual(
      await reporterWriter(answer(reply("escalate")), 1000, log)(task),
      NO_REPLY
    );
    assert.equal(events[0]?.fields.decision, "verdict");
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

  it("asks the done task to say null unless staff describe a change", () => {
    const prompt = writerPrompt({
      foreman: [],
      kind: "done",
      staff: ["Could not reproduce."],
      title: "Notes not saving",
    });
    assert.ok(prompt.includes("- Could not reproduce."));
    assert.ok(prompt.includes("When in doubt, use null."));
  });

  it("asks the reason task to judge whether the product works as designed", () => {
    const prompt = writerPrompt({
      foreman: [],
      kind: "reason",
      staff: ["Expected behaviour."],
      title: "Export stops at a year",
    });
    assert.ok(prompt.includes("Set asDesigned to true when"));
  });

  it("keeps a staff explanation in the prompt however many Foreman notes follow it", () => {
    const prompt = writerPrompt({
      foreman: Array.from({ length: 7 }, (_, i) => `Foreman status note ${i}`),
      kind: "reason",
      staff: ["This is how exports are meant to work: they cover 12 months."],
      title: "Export stops at a year",
    });
    assert.ok(
      prompt.includes(
        "- This is how exports are meant to work: they cover 12 months."
      )
    );
    assert.ok(
      prompt.indexOf("Comments from our staff") <
        prompt.indexOf("Comments from Foreman")
    );
    assert.ok(!prompt.includes("Foreman status note 1"));
    assert.ok(prompt.includes("Foreman status note 6"));
  });

  it("gives the verdict task Fixy's reply, clipped, and the outcome rules", () => {
    const prompt = writerPrompt({
      kind: "verdict",
      reply: `I fixed and proved the bug. ${"x".repeat(5000)}`,
      title: "Webhook guide link is a 404",
    });
    assert.ok(prompt.includes("Final note from our investigation:\nI fixed"));
    assert.ok(!prompt.includes("x".repeat(3000)));
    for (const outcome of [
      "fix_in_review",
      "not_a_bug",
      "already_fixed",
      "cannot_reproduce",
      "none",
    ]) {
      assert.ok(
        prompt.includes(`Set verdict to ${outcome} when`) ||
          prompt.includes(`Set verdict to ${outcome} for`),
        outcome
      );
    }
    assert.ok(prompt.includes("even if it also raises internal follow-ups"));
  });

  it("never asks for owners, developers or engineering words", () => {
    assert.ok(writerPrompt(TASK).includes("Never mention developers, owners"));
  });
});
