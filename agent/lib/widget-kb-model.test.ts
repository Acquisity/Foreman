import assert from "node:assert/strict";
import { test } from "node:test";
import { MODELS } from "./models.js";
import { withKbModel } from "./widget-kb-model.js";

test("KB fails over once to a different provider of the same model", async () => {
  const providers: unknown[] = [];
  const value = await withKbModel(
    MODELS.kb,
    new AbortController().signal,
    (_signal, options) => {
      providers.push(options.providerOptions.gateway?.order);
      if (providers.length === 1) {
        throw new DOMException("slow provider", "TimeoutError");
      }
      return Promise.resolve("grounded answer");
    }
  );
  assert.equal(value, "grounded answer");
  assert.deepEqual(providers, [["vertex"], ["google"]]);
});

test("KB preserves cancellation and does not apply Gemini providers to model overrides", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    withKbModel(MODELS.kb, controller.signal, () => {
      calls += 1;
      controller.abort();
      throw new Error("cancelled");
    })
  );
  assert.equal(calls, 1);
  await withKbModel(
    "openai/another-model",
    new AbortController().signal,
    (_signal, options) => {
      assert.equal(options.providerOptions.gateway, undefined);
      return Promise.resolve("answer");
    }
  );
});
