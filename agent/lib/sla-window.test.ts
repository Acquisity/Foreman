import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FIRST_RUN_WINDOW_MS,
  MAX_WINDOW_MS,
  slaWindowStart,
} from "./sla-window.js";

const NOW = Date.parse("2026-08-20T09:00:00.000Z");

test("sla report window", async (t) => {
  await t.test("falls back to one day when no marker exists", () => {
    assert.equal(
      slaWindowStart(null, NOW),
      new Date(NOW - FIRST_RUN_WINDOW_MS).toISOString()
    );
  });

  await t.test("falls back to one day when the marker is unparseable", () => {
    assert.equal(
      slaWindowStart("not a timestamp", NOW),
      new Date(NOW - FIRST_RUN_WINDOW_MS).toISOString()
    );
  });

  await t.test("catches up from the previous dispatch", () => {
    const previous = new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(slaWindowStart(previous, NOW), previous);
  });

  await t.test("floors a stale marker at the maximum window", () => {
    const stale = new Date(NOW - 90 * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(
      slaWindowStart(stale, NOW),
      new Date(NOW - MAX_WINDOW_MS).toISOString()
    );
  });
});
