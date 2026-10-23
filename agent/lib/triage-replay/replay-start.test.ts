import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import {
  loadReplayState,
  memoryBackend,
  type ReplayBackend,
  replayStateKey,
  setReplayBackend,
  withReplayState,
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
import {
  type AdmissionLedger,
  REPLAY_SECRET_HEADER,
  RESERVATION_LEASE_MS,
  readReplayResult,
  replayStamp,
  startReplay,
} from "./route.js";

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

  describe("when the ledger can't confirm a dispatched start", () => {
    const dispatchedWithoutConfirm = async (t: TestContext) => {
      const backend = memoryBackend();
      const shared = sharedLedger();
      let ledgerDown = false;
      const ledger = (): AdmissionLedger => {
        const inner = shared();
        return {
          read: inner.read,
          write: (run, entries, etag) =>
            ledgerDown
              ? Promise.reject(new Error("ledger down"))
              : inner.write(run, entries, etag),
        };
      };
      const { args, sent } = server(t, backend);
      const dispatching = {
        from: (address: string) => ({
          send: (message: string, options: unknown) => {
            ledgerDown = true;
            return args.from(address).send(message, options);
          },
        }),
      };
      const first = await startReplay(start(), dispatching, ledger());
      ledgerDown = false;
      const later = Date.now() + RESERVATION_LEASE_MS + 1;
      t.mock.method(Date, "now", () => later);
      return { args, backend, first, ledger: shared, sent };
    };

    const settled = async (ledger: ReturnType<typeof sharedLedger>) => {
      const entries = await ledger().read(RUN);
      return {
        admitted: entries.admitted,
        charged: entries.chargedUsd,
        reserved: Object.keys(entries.reserved),
      };
    };

    it("keeps the dispatched run and its charge, and never starts it twice on a retry", async (t) => {
      const { args, first, ledger, sent } = await dispatchedWithoutConfirm(t);
      assert.equal(first.status, 200);
      assert.deepEqual(await settled(ledger), {
        admitted: [],
        charged: 4,
        reserved: [KEY],
      });
      const retry = await startReplay(start(), args, ledger());
      assert.equal(retry.status, 409);
      assert.equal(sent.length, 1);
      assert.deepEqual(await settled(ledger), {
        admitted: [KEY],
        charged: 4,
        reserved: [],
      });
    });

    it("keeps the dispatched run's slot and charge when a retry can't read the store", async (t) => {
      const { args, backend, ledger, sent } = await dispatchedWithoutConfirm(t);
      setReplayBackend({
        ...backend,
        read: () => Promise.reject(new Error("blob down")),
      });
      await assert.rejects(startReplay(start(), args, ledger()), BLOB_DOWN);
      assert.equal(sent.length, 1);
      assert.deepEqual(await settled(ledger), {
        admitted: [],
        charged: 4,
        reserved: [KEY],
      });
    });

    it("never refunds a run whose session has already stepped", async (t) => {
      const { args, ledger, sent } = await dispatchedWithoutConfirm(t);
      await withReplayState(RUN, KEY, (state) => {
        state.steps = 3;
      });
      const retry = await startReplay(start(), args, ledger());
      assert.equal(retry.status, 409);
      assert.equal(sent.length, 1);
      assert.deepEqual(await settled(ledger), {
        admitted: [KEY],
        charged: 4,
        reserved: [],
      });
    });
  });

  it("stamps the result with the deployment's commit, the start time and the estimated cost", async (t) => {
    const backend = memoryBackend();
    const { args } = server(t, backend);
    process.env.VERCEL_GIT_COMMIT_SHA = `${"c".repeat(40)}\n`;
    const ledger = sharedLedger();
    assert.equal((await startReplay(start(), args, ledger())).status, 200);
    const read = await readReplayResult({
      caseKey: KEY,
      cohortSha256: "0".repeat(64),
      runId: RUN,
    });
    assert.equal(read?.result.foremanCommit, "c".repeat(40));
    assert.equal(read?.result.estimatedUsd, 4);
    assert.ok(Date.now() - Date.parse(read?.result.startedAt ?? "") < 60_000);
  });

  it("restamps a store left by a failed send with the deployment that retries it", async (t) => {
    const backend = memoryBackend();
    const { args, failSendOnce } = server(t, backend);
    const ledger = sharedLedger();
    process.env.VERCEL_GIT_COMMIT_SHA = "a".repeat(40);
    const restore = failSendOnce();
    await assert.rejects(startReplay(start(), args, ledger()), SESSION_DOWN);
    restore();
    const redeployedAt = Date.now();
    process.env.VERCEL_GIT_COMMIT_SHA = "b".repeat(40);
    process.env.TRIAGE_REPLAY_EST_USD_PER_CASE = "6";
    assert.equal((await startReplay(start(), args, ledger())).status, 200);
    const read = await readReplayResult({
      caseKey: KEY,
      cohortSha256: "0".repeat(64),
      runId: RUN,
    });
    assert.equal(read?.result.foremanCommit, "b".repeat(40));
    assert.equal(read?.result.estimatedUsd, 6);
    assert.ok(Date.parse(read?.result.startedAt ?? "") >= redeployedAt);
  });

  it("records the commit as unknown when the deployment names none", () => {
    assert.deepEqual(
      replayStamp({ TRIAGE_REPLAY_EST_USD_PER_CASE: "2.5" }, new Date(0)),
      {
        estimatedUsd: 2.5,
        foremanCommit: "unknown",
        startedAt: "1970-01-01T00:00:00.000Z",
      }
    );
  });
});
