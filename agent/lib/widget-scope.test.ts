import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionAuthContext } from "eve/context";
import { sandboxSessionOptions } from "../sandbox.js";
import { isFinInvestigation } from "./fin-investigation-auth.js";
import { sessionLane } from "./session-lane.js";
import { isUnattended } from "./trust.js";
import { verifiedWidgetContext } from "./widget.fixture.js";
import {
  isWidgetSupport,
  requireWidgetContext,
  WIDGET_SUPPORT_ISSUER,
  widgetAuth,
  widgetContext,
} from "./widget-scope.js";

const PROVIDER_TOOL = /widget_provider/;
const NO_CUSTOMER_TEXT = /never address the customer/;
const NO_SCOPE = /no valid verified scope/;

test("stamps the verified scope, unattended, under the widget issuer", () => {
  const auth = widgetAuth(verifiedWidgetContext);
  assert.equal(auth.issuer, WIDGET_SUPPORT_ISSUER);
  assert.equal(auth.principalId, verifiedWidgetContext.userId);
  assert.equal(isUnattended(auth), true);
  assert.deepEqual(widgetContext(auth), verifiedWidgetContext);
  assert.deepEqual(requireWidgetContext(auth), verifiedWidgetContext);
});

test("a widget session is not a Fin investigation and never gets the Fin model", () => {
  const auth = widgetAuth(verifiedWidgetContext);
  assert.equal(isWidgetSupport(auth), true);
  assert.equal(isFinInvestigation(auth), false);
});

test("the widget lane keeps Executor helpers and strips repository and sandbox network", () => {
  const auth = widgetAuth(verifiedWidgetContext);
  const lane = sessionLane(auth);
  assert.equal(lane.broadExecutor, false);
  assert.equal(lane.customer, true);
  assert.equal(lane.repository, false);
  assert.match(lane.discovery, PROVIDER_TOOL);
  assert.match(lane.instructions, NO_CUSTOMER_TEXT);
  assert.deepEqual(sandboxSessionOptions(auth), { networkPolicy: "deny-all" });
});

test("a malformed widget issuer stays in the lane but has no usable scope", () => {
  const forged = {
    ...widgetAuth(verifiedWidgetContext),
    attributes: { ...verifiedWidgetContext, organizationId: "not-a-workspace" },
  } satisfies SessionAuthContext;
  assert.equal(isWidgetSupport(forged), true);
  assert.equal(widgetContext(forged), null);
  assert.throws(() => requireWidgetContext(forged));
  assert.match(sessionLane(forged).instructions, NO_SCOPE);
});
