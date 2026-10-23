import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ARCHIVE_URL,
  auth,
  KEY,
  lists,
  RUN,
  sharedLedger,
  triageCase,
} from "./fixtures.js";
import {
  TRIAGE_REPLAY_CASE_ATTRIBUTE,
  TRIAGE_REPLAY_RUN_ATTRIBUTE,
} from "./mode.js";
import {
  type AdmissionLedger,
  confirm,
  RESERVATION_LEASE_MS,
  release,
  replayRefusal,
  reserve,
  type StartRequest,
  startRequestSchema,
} from "./route.js";

const ONE_SLOT = /used its 1 admitted/u;
const STARTING = /already starting/u;
const STARTED = /already started/u;
const NEVER_SETTLED = /never settled/u;
const BUDGET_USED = /used its 2 admitted/u;
const NOT_APPROVED = /not the one approved/u;
const KEPT_CHANGING = /kept changing/u;
const SPEND_CAP = /estimated \$8\.00 of its \$10\.00 model spend cap/u;
const COST_UNSET = /must both be set/u;

describe("replay routes", () => {
  const admit = async (
    startRequest: StartRequest,
    from: AdmissionLedger,
    settings: Record<string, string>
  ) => {
    const refused = await reserve(startRequest, from, settings);
    if (refused === null) {
      await confirm(startRequest, from);
    }
    return refused;
  };
  const request: StartRequest = {
    archiveUrl: ARCHIVE_URL,
    case: triageCase,
    cohortSha256: "0".repeat(64),
    lists,
    run: 1,
    runId: RUN,
  };
  const ledger = sharedLedger();
  const env = {
    TRIAGE_REPLAY_EST_USD_PER_CASE: "4",
    TRIAGE_REPLAY_MAX_RUNS: "2",
    TRIAGE_REPLAY_MAX_USD: "100",
    TRIAGE_REPLAY_RUN_ID: RUN,
  };

  it("admits up to the run's budget, across a restart", async () => {
    assert.equal(await admit(request, ledger(), env), null);
    assert.equal(await admit({ ...request, run: 2 }, ledger(), env), null);
    // A fresh ledger object is a restarted process reading the same Blob ledger.
    assert.match(
      String(await admit({ ...request, run: 3 }, ledger(), env)),
      BUDGET_USED
    );
    assert.match(
      String(
        await admit(request, ledger(), {
          ...env,
          TRIAGE_REPLAY_RUN_ID: "other",
        })
      ),
      NOT_APPROVED
    );
  });

  it("admits no more than the allowance when starts race, and records each one", async () => {
    const racing = sharedLedger();
    const one = { ...env, TRIAGE_REPLAY_MAX_RUNS: "1" };
    const outcomes = await Promise.all([
      reserve(request, racing(), one),
      reserve({ ...request, run: 2 }, racing(), one),
      reserve({ ...request, run: 3 }, racing(), one),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome === null).length, 1);
    assert.equal(Object.keys((await racing().read(RUN)).reserved).length, 1);
    const three = { ...env, TRIAGE_REPLAY_MAX_RUNS: "3" };
    const roomy = sharedLedger();
    await Promise.all([
      admit(request, roomy(), three),
      admit({ ...request, run: 2 }, roomy(), three),
    ]);
    assert.deepEqual(
      (await roomy().read(RUN)).admitted.sort((a, b) => a.localeCompare(b)),
      ["ENG-100#1", "ENG-100#2"]
    );
  });

  it("holds a slot and its spend while a start is reserved, and gives both back on release", async () => {
    const held = sharedLedger();
    const one = { ...env, TRIAGE_REPLAY_MAX_RUNS: "1" };
    assert.equal(await reserve(request, held(), one), null);
    assert.match(
      String(await reserve({ ...request, run: 2 }, held(), one)),
      ONE_SLOT
    );
    assert.equal((await held().read(RUN)).chargedUsd, 4);
    await release(request, held(), one);
    const freed = await held().read(RUN);
    assert.deepEqual(
      [freed.admitted, freed.chargedUsd, freed.reserved],
      [[], 0, {}]
    );
    assert.equal(await reserve({ ...request, run: 2 }, held(), one), null);
  });

  it("refuses a second start of the same case and run while the first is fresh, and never takes over a stale one", async () => {
    const twice = sharedLedger();
    const start = 1_000_000;
    assert.equal(await reserve(request, twice(), env, start), null);
    assert.match(
      String(await reserve(request, twice(), env, start + 1000)),
      STARTING
    );
    assert.match(
      String(
        await reserve(request, twice(), env, start + RESERVATION_LEASE_MS)
      ),
      NEVER_SETTLED
    );
    const after = await twice().read(RUN);
    assert.equal(after.chargedUsd, 4);
    assert.deepEqual(Object.keys(after.reserved), ["ENG-100#1"]);
    await confirm(request, twice());
    assert.match(
      String(
        await reserve(request, twice(), env, start + 10 * RESERVATION_LEASE_MS)
      ),
      STARTED
    );
    assert.deepEqual((await twice().read(RUN)).reserved, {});
  });

  it("charges each start's estimated cost in the ledger and refuses the start that would pass the run's dollar cap", async () => {
    const capped = sharedLedger();
    const tight = {
      ...env,
      TRIAGE_REPLAY_MAX_RUNS: "10",
      TRIAGE_REPLAY_MAX_USD: "10",
    };
    assert.equal(await admit(request, capped(), tight), null);
    assert.equal(await admit({ ...request, run: 2 }, capped(), tight), null);
    assert.match(
      String(await admit({ ...request, run: 3 }, capped(), tight)),
      SPEND_CAP
    );
    assert.deepEqual(await capped().read(RUN), {
      admitted: ["ENG-100#1", "ENG-100#2"],
      chargedUsd: 8,
      etag: "v4",
      reserved: {},
    });
  });

  it("refuses every start when the dollar cap or the per-case estimate is unset", async () => {
    const fresh = sharedLedger();
    const { TRIAGE_REPLAY_MAX_USD: _cap, ...noCap } = env;
    const { TRIAGE_REPLAY_EST_USD_PER_CASE: _estimate, ...noEstimate } = env;
    const refusals = await Promise.all(
      [noCap, noEstimate, { ...env, TRIAGE_REPLAY_MAX_USD: "0" }].map(
        (settings) => admit(request, fresh(), settings)
      )
    );
    for (const refusal of refusals) {
      assert.match(String(refusal), COST_UNSET);
    }
    assert.equal((await fresh().read(RUN)).admitted.length, 0);
  });

  it("fails closed when the ledger keeps losing the race", async () => {
    const stuck: AdmissionLedger = {
      read: () =>
        Promise.resolve({
          admitted: [],
          chargedUsd: 0,
          etag: "v1",
          reserved: {},
        }),
      write: () => Promise.resolve("conflict"),
    };
    assert.match(String(await admit(request, stuck, env)), KEPT_CHANGING);
  });

  it("accepts only a replay archive in Foreman's Blob store", () => {
    const parse = (archiveUrl: string) =>
      startRequestSchema.safeParse({ ...request, archiveUrl }).success;
    assert.equal(parse(ARCHIVE_URL), true);
    assert.equal(
      parse("https://example.com/triage-replay/archives/a.tgz"),
      false
    );
    assert.equal(
      parse("https://store.public.blob.vercel-storage.com/other/a.tgz"),
      false
    );
  });

  it("refuses without the server's confirm flag or the secret", () => {
    const secret = "s".repeat(40);
    const req = (header?: string) =>
      new Request("http://localhost/internal/triage/replay", {
        headers: header ? { "x-foreman-diagnostics-secret": header } : {},
      });
    const base = { FOREMAN_DIAGNOSTICS_SECRET: secret, TRIAGE_REPLAY: "1" };
    assert.equal(replayRefusal(req(secret), {})?.status, 404);
    assert.equal(replayRefusal(req("wrong"), base)?.status, 403);
    assert.equal(replayRefusal(req(secret), base)?.status, 403);
    assert.equal(
      replayRefusal(req(secret), { ...base, TRIAGE_REPLAY_CONFIRM: "1" }),
      null
    );
  });

  it("stamps replay sessions as triage intake with the case and run", () => {
    assert.equal(auth.attributes[TRIAGE_REPLAY_CASE_ATTRIBUTE], KEY);
    assert.equal(auth.attributes[TRIAGE_REPLAY_RUN_ATTRIBUTE], RUN);
  });
});
