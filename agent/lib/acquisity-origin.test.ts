import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { acquisityOrigin } from "./acquisity-origin.js";

function configure(context: TestContext, value: string) {
  const previous = process.env.ACQUISITY_ORIGIN;
  process.env.ACQUISITY_ORIGIN = value;
  context.after(() => {
    if (previous === undefined) {
      delete process.env.ACQUISITY_ORIGIN;
    } else {
      process.env.ACQUISITY_ORIGIN = previous;
    }
  });
}

for (const value of ["http://localhost:3939", "http://127.0.0.1:3939"]) {
  test(`accepts local http origin ${value} outside production only`, (context) => {
    const previousEnv = process.env.NODE_ENV;
    context.after(() => {
      process.env.NODE_ENV = previousEnv;
    });
    process.env.NODE_ENV = "development";
    configure(context, value);
    assert.equal(acquisityOrigin(), value);
    process.env.NODE_ENV = "production";
    assert.throws(() => acquisityOrigin());
  });
}

test("never accepts a non-loopback http origin", (context) => {
  const previousEnv = process.env.NODE_ENV;
  context.after(() => {
    process.env.NODE_ENV = previousEnv;
  });
  process.env.NODE_ENV = "development";
  configure(context, "http://app.acquisity.ai");
  assert.throws(() => acquisityOrigin());
});
