import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionAuthContext } from "eve/context";

describe("widget_read_help_article tool", () => {
  it("is exposed only for widget support auth", async () => {
    const dynamic = (await import("../tools/widget_read_help_article.js"))
      .default;

    const widgetCtx = {
      session: {
        auth: {
          initiator: {
            attributes: {},
            issuer: "foreman:widget-support",
          } as SessionAuthContext,
        },
      },
    };
    const nonWidgetCtx = { session: { auth: { initiator: null } } };

    assert.ok(
      dynamic.events["step.started"]?.({}, widgetCtx as any),
      "tool should be exposed for widget auth"
    );
    assert.equal(
      dynamic.events["step.started"]?.({}, nonWidgetCtx as any),
      null,
      "tool should be hidden for non-widget auth"
    );
  });
});
