import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { loadReplayState, memoryBackend, setReplayBackend } from "./backend.js";
import { ARCHIVE_URL, lists, TEST_SECRET, triageCase } from "./fixtures.js";
import {
  buildReplayResult,
  REPLAY_SECRET_HEADER,
  replayResultResponse,
  startReplay,
} from "./route.js";

const start = (runId: string, run = 1, secret = TEST_SECRET) =>
  new Request("http://localhost/internal/triage/replay", {
    body: JSON.stringify({
      archiveUrl: ARCHIVE_URL,
      case: triageCase,
      lists,
      run,
      runId,
    }),
    headers: {
      "content-type": "application/json",
      [REPLAY_SECRET_HEADER]: secret,
    },
    method: "POST",
  });

function server(t: TestContext, env: Record<string, string> = {}) {
  const prior = { ...process.env };
  Object.assign(process.env, {
    FOREMAN_DIAGNOSTICS_SECRET: TEST_SECRET,
    TRIAGE_REPLAY: "1",
    VERCEL_GIT_COMMIT_SHA: "c".repeat(40),
    ...env,
  });
  setReplayBackend(memoryBackend());
  t.after(() => {
    process.env = prior;
  });
  const sent: string[] = [];
  return {
    args: {
      from: (address: string) => ({
        send: () => {
          sent.push(address);
          return Promise.resolve({ id: `sess-${sent.length}` });
        },
      }),
    },
    sent,
  };
}

describe("starting a replay", () => {
  it("answers 404 outside a replay process and 403 without the secret", async (t) => {
    const { args, sent } = server(t, { TRIAGE_REPLAY: "0" });
    assert.equal((await startReplay(start("run-off-1"), args)).status, 404);
    process.env.TRIAGE_REPLAY = "1";
    assert.equal(
      (await startReplay(start("run-off-1", 1, "x".repeat(40)), args)).status,
      403
    );
    assert.deepEqual(sent, []);
  });

  it("seeds the case's store, sends the ticket as filed, and refuses a repeat", async (t) => {
    const { args, sent } = server(t);
    const started = await startReplay(start("run-seed-1"), args);
    assert.equal(started.status, 200);
    assert.deepEqual(await started.json(), {
      caseKey: "ENG-100#1",
      sessionId: "sess-1",
    });
    assert.deepEqual(sent, ["triage-replay:run-seed-1:ENG-100#1"]);
    const stored = await loadReplayState("run-seed-1", "ENG-100#1");
    assert.equal(stored?.stamp.foremanCommit, "c".repeat(40));
    assert.equal(stored?.archive.url, ARCHIVE_URL);
    assert.equal(
      stored && buildReplayResult(stored, "run-seed-1").status,
      "failed"
    );
    assert.equal((await startReplay(start("run-seed-1"), args)).status, 409);
    assert.equal(sent.length, 1);
    const polled = await replayResultResponse(
      new Request(
        "http://localhost/internal/triage/replay/result?caseKey=ENG-100%231&runId=run-seed-1",
        { headers: { [REPLAY_SECRET_HEADER]: TEST_SECRET } }
      )
    );
    assert.equal(
      ((await polled.json()) as { settled: boolean }).settled,
      false
    );
  });

  it("stops at TRIAGE_REPLAY_MAX_RUNS starts", async (t) => {
    const { args, sent } = server(t, { TRIAGE_REPLAY_MAX_RUNS: "2" });
    const statuses: number[] = [];
    for (const run of [1, 2, 3]) {
      // biome-ignore lint/performance/noAwaitInLoops: starts are counted in order.
      statuses.push((await startReplay(start("run-cap-1", run), args)).status);
    }
    assert.equal(statuses.at(-1), 429);
    assert.ok(sent.length <= 2);
  });
});
