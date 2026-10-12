import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import { rewriteDraft } from "./intake-writer.js";

const DRAFT = "Refund of $49 for ENG-123 was issued on 2026-10-01.";

describe("rewriteDraft", () => {
  it("returns the draft unchanged when the writer call throws", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: () => Promise.reject(new Error("proxy down")),
    });
    assert.equal(
      await rewriteDraft(DRAFT, 4000, new AbortController().signal, model),
      DRAFT
    );
  });

  it("still throws when the turn is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const model = new MockLanguageModelV4({
      doGenerate: () => Promise.reject(new Error("aborted")),
    });
    await assert.rejects(rewriteDraft(DRAFT, 4000, controller.signal, model));
  });
});
