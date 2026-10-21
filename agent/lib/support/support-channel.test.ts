import assert from "node:assert/strict";
import { test } from "node:test";
import channel from "../../channels/support.js";
import { evePackageUrl } from "../eve-dynamic-tools.js";

const { ContextContainer, contextStorage } = (await import(
  new URL("./dist/src/context/container.js", evePackageUrl()).href
)) as {
  ContextContainer: new () => {
    setVirtualContext: (key: unknown, value: unknown) => void;
  };
  contextStorage: { run: <T>(store: unknown, body: () => T) => T };
};
const { SessionKey } = (await import(
  new URL("./dist/src/context/keys.js", evePackageUrl()).href
)) as { SessionKey: unknown };

type TerminalEvent = "turn.cancelled" | "turn.failed";

// defineChannel's public type hides the adapter eve dispatches events through.
const { adapter } = channel as unknown as {
  adapter: Record<
    TerminalEvent,
    (event: unknown, context: { state: { claim: null } }) => Promise<void>
  >;
};

const claimReads = async (event: TerminalEvent, parent?: { id: string }) => {
  const store = new ContextContainer();
  store.setVirtualContext(SessionKey, {
    auth: { current: null, initiator: null },
    parent,
    sessionId: "session",
    turn: { id: "turn", sequence: 1 },
  });
  let reads = 0;
  const state = {
    get claim() {
      reads += 1;
      return null;
    },
  };
  await contextStorage.run(store, () => adapter[event]({}, { state }));
  return reads;
};

for (const event of ["turn.cancelled", "turn.failed"] as const) {
  test(`${event} settles only the root claim`, async () => {
    assert.equal(await claimReads(event), 1);
    assert.equal(await claimReads(event, { id: "p" }), 0);
  });
}
