import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reporterUpdatesConfig } from "./config.js";

const base = {
  REPORTER_UPDATES_CHANNELS: "C0AAAAAAAAA, C0BBBBBBBBB",
  REPORTER_UPDATES_ENABLED: "true",
  REPORTER_UPDATES_SINCE: "2026-10-01T00:00:00Z",
};

describe("reporterUpdatesConfig", () => {
  it("is off unless explicitly enabled", () => {
    assert.equal(reporterUpdatesConfig({}), null);
    assert.equal(
      reporterUpdatesConfig({ ...base, REPORTER_UPDATES_ENABLED: "1" }),
      null
    );
  });

  it("needs at least one valid channel and a valid start date", () => {
    assert.equal(
      reporterUpdatesConfig({ ...base, REPORTER_UPDATES_CHANNELS: "" }),
      null
    );
    assert.equal(
      reporterUpdatesConfig({ ...base, REPORTER_UPDATES_CHANNELS: "general" }),
      null
    );
    assert.equal(
      reporterUpdatesConfig({ ...base, REPORTER_UPDATES_SINCE: "soon" }),
      null
    );
    assert.equal(
      reporterUpdatesConfig({ ...base, REPORTER_UPDATES_SINCE: undefined }),
      null
    );
  });

  it("reads the channels, cutoff and defaults", () => {
    const config = reporterUpdatesConfig(base);
    assert.deepEqual(
      [...(config?.channels ?? [])],
      ["C0AAAAAAAAA", "C0BBBBBBBBB"]
    );
    assert.equal(config?.since, "2026-10-01T00:00:00.000Z");
    assert.equal(config?.lookbackMs, 12 * 3_600_000);
    assert.equal(config?.maxPosts, 20);
    assert.equal(config?.nameOwner, true);
  });

  it("bounds the lookback and the post cap, and can switch owner names off", () => {
    const config = reporterUpdatesConfig({
      ...base,
      REPORTER_UPDATES_LOOKBACK_HOURS: "9999",
      REPORTER_UPDATES_MAX_POSTS: "5000",
      REPORTER_UPDATES_NAME_OWNER: "false",
    });
    assert.equal(config?.lookbackMs, 72 * 3_600_000);
    assert.equal(config?.maxPosts, 100);
    assert.equal(config?.nameOwner, false);
    assert.equal(
      reporterUpdatesConfig({ ...base, REPORTER_UPDATES_MAX_POSTS: "abc" })
        ?.maxPosts,
      20
    );
  });
});
