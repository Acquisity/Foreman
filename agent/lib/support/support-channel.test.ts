import assert from "node:assert/strict";
import { test } from "node:test";
import channel, { settleRootTurn } from "../../channels/support.js";

const claimReads = (parent?: unknown) => {
  let reads = 0;
  const state = {
    get claim() {
      reads += 1;
      return null;
    },
  };
  return settleRootTurn({}, { state }, { session: { parent } }).then(
    () => reads
  );
};

test("root turn.cancelled settles the claim like root turn.failed, children never do", async () => {
  // defineChannel types hide the adapter eve dispatches channel events from.
  const { adapter } = channel as unknown as {
    adapter: Record<string, unknown>;
  };
  assert.equal(typeof adapter["turn.cancelled"], "function");
  assert.equal(typeof adapter["turn.failed"], "function");
  // The root reads its claim to settle it; a child returns before touching it.
  assert.equal(await claimReads(), 1);
  assert.equal(await claimReads({ id: "p" }), 0);
});
