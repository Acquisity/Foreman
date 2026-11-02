import assert from "node:assert/strict";
import { describe, it } from "node:test";
import routeTicketTool from "../../tools/route_ticket.js";
import { withReplayState } from "./backend.js";
import {
  ctx,
  inSession,
  KEY,
  outputOf,
  RUN,
  replayProcess,
  state,
} from "./fixtures.js";

/** A master from January: the case was filed 1 Oct 2026, so the 30-day cutoff excludes it. */
const OLD_MASTER = "ENG-210";

const CREATED_BEFORE = /ENG-210 was created before/u;

const MASTER_BODY =
  "## Root cause\n\nThe token refresh drops the inbox session.\n\n## Regression seam\n\nReconnect after a send.";

describe("route_ticket applies the session cutoff to a parent-only Duplicate retry (Aaron, #259)", () => {
  it("refuses a master created long before the case when the retry names only parent, through the tool", async (t) => {
    await replayProcess(t);
    await withReplayState(RUN, KEY, (s) => {
      s.case.relatedSnapshot.push({
        assignee: null,
        createdAt: "2026-01-15T00:00:00.000Z",
        description: MASTER_BODY,
        id: OLD_MASTER,
        labels: ["Bug"],
        parent: null,
        state: "Todo",
        title: "Master: inbox reconnect after send",
      });
    });
    // No decision is recorded, so routeRefusal lets the call through, as it
    // does for the retry writeUpdate recommends.
    const result = await inSession(() =>
      outputOf(
        routeTicketTool.execute(
          { issue: "ENG-100", parent: OLD_MASTER, state: "Duplicate" },
          ctx as never
        )
      )
    );
    assert.equal(result.routed, false);
    assert.match(String(result.error), CREATED_BEFORE);
    assert.notEqual((await state()).issue.state, "Duplicate");
  });
});
