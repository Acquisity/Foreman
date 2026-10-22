import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { eveSandboxImage } from "./repository-snapshot.js";

function setEnv(context: TestContext, name: string, value: string | undefined) {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  context.after(() => {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  });
}

const resolverMovedMessage =
  "eve's sandbox image resolver moved and the snapshot builder must be re-checked.";
const { resolveVercelEveSandboxImage } = (await import(
  new URL(
    "../../node_modules/eve/dist/src/execution/sandbox/bindings/eve-image.js",
    import.meta.url
  ).href
).catch((cause) => {
  throw new Error(resolverMovedMessage, { cause });
})) as { resolveVercelEveSandboxImage?: () => string };
assert.ok(
  typeof resolveVercelEveSandboxImage === "function",
  resolverMovedMessage
);

test("builds the warm snapshot from the installed eve sandbox image", (context) => {
  setEnv(context, "EVE_SANDBOX_IMAGE_TAG", undefined);
  assert.equal(eveSandboxImage(), resolveVercelEveSandboxImage());
});

test("honors EVE_SANDBOX_IMAGE_TAG like eve does", (context) => {
  setEnv(context, "EVE_SANDBOX_IMAGE_TAG", "  custom-tag  ");
  assert.equal(eveSandboxImage(), resolveVercelEveSandboxImage());
  process.env.EVE_SANDBOX_IMAGE_TAG = "   ";
  assert.equal(eveSandboxImage(), resolveVercelEveSandboxImage());
});
