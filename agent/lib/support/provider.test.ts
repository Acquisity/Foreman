import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { creationRole } from "./config.js";
import { SupportRefusal } from "./errors.js";
import { assertSupportIssueSource, supportIssueInput } from "./provider.js";

const claim = {
  conversation: "123",
  lease: "11111111-1111-4111-8111-111111111111",
  thread: "1234567890.123456",
};

test("missing Linear descriptions refuse matching without an infrastructure failure", () => {
  for (const role of creationRole.options) {
    for (const issue of [{}, { description: null }, { description: "" }]) {
      assert.throws(
        () => assertSupportIssueSource(issue, claim, role),
        SupportRefusal
      );
    }
  }
});

test("existing Linear source and operation markers still match only their case", () => {
  for (const role of creationRole.options) {
    const issue = supportIssueInput(claim, role, {
      description: "Investigation",
    });
    assert.doesNotThrow(() => assertSupportIssueSource(issue, claim, role));
    assert.throws(
      () =>
        assertSupportIssueSource(
          issue,
          { ...claim, conversation: "456" },
          role
        ),
      SupportRefusal
    );
  }
});

test("malformed Linear description types remain provider data errors", () => {
  assert.throws(
    () => assertSupportIssueSource({ description: 123 }, claim, "billing"),
    z.ZodError
  );
});
