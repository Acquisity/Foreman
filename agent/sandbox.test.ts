import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedWidgetContext } from "./lib/widget.fixture.js";
import { widgetAuth } from "./lib/widget-scope.js";
import { sandboxSessionOptions } from "./sandbox.js";

test("customer investigations receive a deny-all sandbox network policy", () => {
  assert.deepEqual(sandboxSessionOptions(widgetAuth(verifiedWidgetContext)), {
    networkPolicy: "deny-all",
  });
  assert.equal(sandboxSessionOptions(null), undefined);
});
