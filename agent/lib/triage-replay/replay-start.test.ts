import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import {
  loadReplayState,
  memoryBackend,
  type ReplayBackend,
  replayStateKey,
  setReplayBackend,
} from "./backend.js";
import {
  ARCHIVE_URL,
  KEY,
  lists,
  RUN,
  sharedLedger,
  TEST_SECRET,
  triageCase,
} from "./fixtures.js";
import { REPLAY_SECRET_HEADER, startReplay } from "./route.js";

const BLOB_DOWN = /blob down/u;
const SESSION_DOWN = /session down/u;

describe("starting a replay", () => {
  const start = () =>
    new Request("http://localhost/internal/triage/replay", {
      body: JSON.stringify({
        archiveUrl: ARCHIVE_URL,
        case: triageCase,
        cohortSha256: "0".repeat(64),
        lists,
        run: 1,
        runId: RUN,
      }),
      headers: {
        "content-type": "application/json",
        [REPLAY_SECRET_HEADER]: TEST_SECRET,
      },
      method: "POST",
    });

  const server = (t: TestContext, backend: ReplayBackend) => {
    const prior = { ...process.env };
    Object.assign(process.env, {
      FOREMAN_DIAGNOSTICS_SECRET: TEST_SECRET,
      TRIAGE_REPLAY: "1",
      TRIAGE_REPLAY_CONFIRM: "1",
      TRIAGE_REPLAY_EST_USD_PER_CASE: "4",
      TRIAGE_REPLAY_MAX_RUNS: "3",
      TRIAGE_REPLAY_MAX_USD: "100",
      TRIAGE_REPLAY_RUN_ID: RUN,
    });
    setReplayBackend(backend);
    t.after(() => {
      process.env = prior;
    });
    const sent: string[] = [];
    let failSend = false;
    const args = {
      from: (address: string) => ({
        send: (_message: string, _options: unknown) => {
          sent.push(address);
          return failSend
            ? Promise.reject(new Error("session down"))
            : Promise.resolve({ id: "sess-1" });
        },
      }),
    };
    return {
      args,
      failSendOnce: () => {
        failSend = true;
        return () => {
          failSend = false;
        };
      },
      sent,
    };
  };

  const failOnce = <T extends keyof ReplayBackend>(
    backend: ReplayBackend,
    method: T
  ): ReplayBackend => {
    let failed = false;
    return {
      ...backend,
      [method]: (...input: unknown[]) => {
        if (!failed) {
          failed = true;
          return Promise.reject(new Error("blob down"));
        }
        return (backend[method] as (...args: unknown[]) => unknown)(...input);
      },
    };
  };

  const afterRetry = async (
    ledger: ReturnType<typeof sharedLedger>,
    backend: ReplayBackend
  ) => {
    const entries = await ledger().read(RUN);
    const stored = await loadReplayState(replayStateKey(RUN, KEY), backend);
    return {
      admitted: entries.admitted,
      charged: entries.chargedUsd,
      inputs: stored?.inputs.length,
      reserved: Object.keys(entries.reserved),
    };
  };

  it("releases the reservation when seeding fails, so the retry starts", async (t) => {
    const backend = failOnce(memoryBackend(), "write");
    const { args, sent } = server(t, backend);
    const ledger = sharedLedger();
    await assert.rejects(startReplay(start(), args, ledger()), BLOB_DOWN);
    assert.deepEqual(await afterRetry(ledger, backend), {
      admitted: [],
      charged: 0,
      inputs: undefined,
      reserved: [],
    });
    assert.deepEqual(sent, []);
    const retry = await startReplay(start(), args, ledger());
    assert.equal(retry.status, 200);
    assert.deepEqual(sent.length, 1);
    assert.deepEqual(await afterRetry(ledger, backend), {
      admitted: [KEY],
      charged: 4,
      inputs: 1,
      reserved: [],
    });
  });

  it("reuses a store whose seed input failed, and adds that input once", async (t) => {
    const backend = failOnce(memoryBackend(), "appendInputs");
    const { args, sent } = server(t, backend);
    const ledger = sharedLedger();
    await assert.rejects(startReplay(start(), args, ledger()), BLOB_DOWN);
    const retry = await startReplay(start(), args, ledger());
    assert.equal(retry.status, 200);
    assert.equal(sent.length, 1);
    assert.deepEqual(await afterRetry(ledger, backend), {
      admitted: [KEY],
      charged: 4,
      inputs: 1,
      reserved: [],
    });
  });

  it("releases the reservation when the session can't be sent, and the retry seeds nothing twice", async (t) => {
    const backend = memoryBackend();
    const { args, failSendOnce, sent } = server(t, backend);
    const ledger = sharedLedger();
    const restore = failSendOnce();
    await assert.rejects(startReplay(start(), args, ledger()), SESSION_DOWN);
    restore();
    assert.deepEqual(await afterRetry(ledger, backend), {
      admitted: [],
      charged: 0,
      inputs: 1,
      reserved: [],
    });
    const retry = await startReplay(start(), args, ledger());
    assert.equal(retry.status, 200);
    assert.equal(sent.length, 2);
    assert.deepEqual(await afterRetry(ledger, backend), {
      admitted: [KEY],
      charged: 4,
      inputs: 1,
      reserved: [],
    });
  });
});
