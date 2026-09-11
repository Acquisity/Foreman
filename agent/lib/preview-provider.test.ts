import assert from "node:assert/strict";
import { test } from "node:test";
import { previewProviderOptions } from "./preview-provider.js";

test("provider preference is inactive outside preview", () => {
  for (const environment of ["production", "development", ""]) {
    assert.equal(previewProviderOptions(environment, "fireworks"), undefined);
    assert.equal(
      previewProviderOptions(environment, "invalid slug"),
      undefined
    );
  }
});

test("preview automatic route remains the default", () => {
  assert.equal(previewProviderOptions("preview", ""), undefined);
});

test("preview preference retains Gateway fallback and adds no reasoning override", () => {
  assert.deepEqual(previewProviderOptions("preview", "fireworks"), {
    providerOptions: { gateway: { order: ["fireworks"] } },
  });
});

test("invalid preview configuration fails before issuing a model request", () => {
  for (const provider of ["fireworks,deepinfra", "bad slug", "a".repeat(65)]) {
    assert.throws(() => previewProviderOptions("preview", provider));
  }
});
