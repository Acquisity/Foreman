import assert from "node:assert/strict";
import { test } from "node:test";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { verifiedWidgetContext as fixture } from "./widget.fixture.js";
import { driftVerdict, gapSentences } from "./widget-live.js";
import {
  assertReplayAllowed,
  LIVE_TICKET,
  replayable,
} from "./widget-replay.js";
import { widgetAuth } from "./widget-scope.js";

const PRODUCTION = /not allowed on production/;
const EXCLUSIVE = /exclusive/;

test("a read is steady when only its read time and key order changed", () => {
  const recorded = {
    inbox: { active: true, errors: 0 },
    observedAt: "2026-10-01T00:00:00Z",
  };
  assert.deepEqual(
    driftVerdict([
      {
        output: recorded,
        reread: {
          inbox: { active: true, errors: 0 },
          observedAt: "2026-10-09T00:00:00Z",
        },
        tool: "widget_inbox_health",
      },
    ]),
    { changed: [], compared: 1, unavailable: [], verdict: "steady" }
  );
  assert.deepEqual(
    driftVerdict([
      { output: recorded, reread: recorded, tool: "widget_account_access" },
      {
        output: recorded,
        reread: {
          inbox: { active: false, errors: 2 },
          observedAt: "2026-10-09T00:00:00Z",
        },
        tool: "widget_inbox_health",
      },
    ]),
    {
      changed: ["widget_inbox_health"],
      compared: 2,
      unavailable: [],
      verdict: "state moved",
    }
  );
});

test("a read that was unavailable when recorded is a gap, not drift", () => {
  assert.deepEqual(
    driftVerdict([
      {
        output: { available: false, unavailable: ["stripe"] },
        reread: { available: true, charges: [1] },
        tool: "widget_billing_summary",
      },
    ]),
    {
      changed: [],
      compared: 0,
      unavailable: ["widget_billing_summary"],
      verdict: "steady",
    }
  );
});

test("refuses live re-runs on production and alongside replay", () => {
  assert.throws(
    () => assertReplayAllowed({ VERCEL_ENV: "production", WIDGET_LIVE: "1" }),
    PRODUCTION
  );
  assert.throws(
    () => assertReplayAllowed({ WIDGET_LIVE: "1", WIDGET_REPLAY: "1" }),
    EXCLUSIVE
  );
  assertReplayAllowed({ VERCEL_ENV: "preview", WIDGET_LIVE: "1" });
});

test("a live re-run reads live and files no ticket", async () => {
  process.env.WIDGET_LIVE = "1";
  try {
    const tool = defineTool({
      description: "Live write.",
      execute: () => {
        throw new Error("ticket filed");
      },
      inputSchema: z.strictObject({}),
    });
    assert.equal(replayable("widget_inbox_health", tool), tool);
    assert.deepEqual(
      await replayable("widget_file_ticket", tool).execute({}, {
        session: { auth: { initiator: widgetAuth(fixture) } },
      } as never),
      LIVE_TICKET
    );
  } finally {
    Reflect.deleteProperty(process.env, "WIDGET_LIVE");
  }
});

test("picks the sentences that say something could not be confirmed", () => {
  assert.deepEqual(
    gapSentences(
      "Your inbox is active. I can’t confirm the send count. No send activity was recorded for that week. Thanks!"
    ),
    [
      "I can’t confirm the send count.",
      "No send activity was recorded for that week.",
    ]
  );
});
