import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const { version } = JSON.parse(
  readFileSync(
    new URL("../../node_modules/eve/package.json", import.meta.url),
    "utf8"
  )
) as { version: string };
const [installedEveVersion] = version.split("+", 1);

test("builds the warm snapshot from the installed eve sandbox image", (context) => {
  setEnv(context, "EVE_SANDBOX_IMAGE_TAG", undefined);
  assert.equal(
    eveSandboxImage(),
    `vcr.vercel.com/vercel/eve/base:${installedEveVersion}`
  );
});

test("honors EVE_SANDBOX_IMAGE_TAG like eve does", (context) => {
  setEnv(context, "EVE_SANDBOX_IMAGE_TAG", "  custom-tag  ");
  assert.equal(eveSandboxImage(), "vcr.vercel.com/vercel/eve/base:custom-tag");
  process.env.EVE_SANDBOX_IMAGE_TAG = "   ";
  assert.equal(
    eveSandboxImage(),
    `vcr.vercel.com/vercel/eve/base:${installedEveVersion}`
  );
});
