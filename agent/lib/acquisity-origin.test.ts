import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { acquisityOrigin } from "./acquisity-origin.js";

function setEnv(context: TestContext, name: string, value: string) {
  const previous = process.env[name];
  process.env[name] = value;
  context.after(() => {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  });
}

const configure = (context: TestContext, value: string) =>
  setEnv(context, "ACQUISITY_ORIGIN", value);
const setNodeEnv = (context: TestContext, value: string) =>
  setEnv(context, "NODE_ENV", value);

for (const value of ["http://localhost:3939", "http://127.0.0.1:3939"]) {
  test(`accepts local http origin ${value} outside production only`, (context) => {
    setNodeEnv(context, "development");
    configure(context, value);
    assert.equal(acquisityOrigin(), value);
    process.env.NODE_ENV = "production";
    assert.throws(() => acquisityOrigin());
  });
}

test("never accepts a non-loopback http origin", (context) => {
  setNodeEnv(context, "development");
  configure(context, "http://app.acquisity.ai");
  assert.throws(() => acquisityOrigin());
});
