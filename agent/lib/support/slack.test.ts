import assert from "node:assert/strict";
import { test } from "node:test";
import { readSupportIntake } from "./slack.js";

const NO_PROGRESS = /could not advance/;
const OUT_OF_BOUNDS = /scan bounds/;

const checkpoint = {
  oldest: "1788959000.000000",
  scan_latest: null,
  scan_newest: null,
};

test("intake continues short history pages using exclusive timestamps", async () => {
  let calls = 0;
  const result = await readSupportIntake(checkpoint, (_operation, input) => {
    calls += 1;
    assert.equal(input.inclusive, "false");
    assert.equal(input.oldest, checkpoint.oldest);
    assert.equal(input.cursor, undefined);
    if (calls === 1) {
      assert.equal(input.latest, undefined);
      return Promise.resolve({
        messages: [{ ts: "1788959002.000000" }],
        ok: true,
        response_metadata: { next_cursor: "expires-between-ticks" },
      });
    }
    assert.equal(input.latest, "1788959002.000000");
    return Promise.resolve({
      has_more: false,
      messages: [{ ts: "1788959001.000000" }],
      ok: true,
    });
  });
  assert.equal(calls, 2);
  assert.equal(result.messages.length, 2);
  assert.deepEqual(result.checkpoint, {
    ...checkpoint,
    oldest: "1788959002.000000",
  });
});

test("intake refuses a continuation without messages or progress", async () => {
  await assert.rejects(
    readSupportIntake(checkpoint, () =>
      Promise.resolve({ has_more: true, messages: [], ok: true })
    ),
    NO_PROGRESS
  );
  await assert.rejects(
    readSupportIntake({ ...checkpoint, scan_latest: "1788959002.000000" }, () =>
      Promise.resolve({
        has_more: true,
        messages: [{ ts: "1788959002.000000" }],
        ok: true,
      })
    ),
    OUT_OF_BOUNDS
  );
});

test("an empty completed gap advances only to the saved frontier", async () => {
  const result = await readSupportIntake(
    {
      ...checkpoint,
      scan_latest: "1788959001.000000",
      scan_newest: "1788959999.000000",
    },
    () => Promise.resolve({ has_more: false, messages: [], ok: true })
  );
  assert.deepEqual(result.checkpoint, {
    oldest: "1788959999.000000",
    scan_latest: null,
    scan_newest: null,
  });
});
