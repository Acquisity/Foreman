import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DeadlineError } from "./deadline.js";
import { githubDeployProbe } from "./deploy.js";
import { MERGE_SHA, NEW_SHA, OLD_SHA } from "./fakes.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const probeWith = (routes: Record<string, () => Response>) => {
  const seen: string[] = [];
  const probe = githubDeployProbe(
    () => Promise.resolve("token"),
    (input: string | URL | Request) => {
      const url = String(input).replace("https://api.github.com", "");
      seen.push(url);
      const route = routes[url];
      return Promise.resolve(route ? route() : json({}, 404));
    }
  );
  return { probe, seen };
};

const DEPLOYMENTS =
  "/repos/Acquisity/Acquisity/deployments?environment=production&per_page=30";
const statusesOf = (id: number) =>
  `/repos/Acquisity/Acquisity/deployments/${id}/statuses?per_page=10`;

const VERCEL = "vercel[bot]";
const statusOf = (state: string, login: string) => ({
  creator: { login },
  state,
});
const DEPLOY_DONE = [
  statusOf("success", VERCEL),
  statusOf("success", "actor"),
  statusOf("in_progress", "actor"),
  statusOf("queued", "actor"),
];
const MIGRATE_ONLY = [
  statusOf("success", "actor"),
  statusOf("in_progress", "actor"),
  statusOf("queued", "actor"),
];
const BUILT_THEN_FAILED = [
  statusOf("error", "actor"),
  statusOf("success", VERCEL),
  statusOf("in_progress", "actor"),
  statusOf("queued", "actor"),
];
const STILL_RUNNING = [
  statusOf("success", VERCEL),
  statusOf("in_progress", "actor"),
  statusOf("queued", "actor"),
];

describe("liveSha", () => {
  it("is the newest deployment that Vercel built and whose job then succeeded", async () => {
    const { probe } = probeWith({
      [DEPLOYMENTS]: () =>
        json([
          { id: 5, sha: NEW_SHA },
          { id: 4, sha: NEW_SHA },
          { id: 3, sha: MERGE_SHA },
          { id: 2, sha: MERGE_SHA },
          { id: 1, sha: OLD_SHA },
        ]),
      [statusesOf(1)]: () => json(DEPLOY_DONE),
      [statusesOf(2)]: () => json(MIGRATE_ONLY),
      [statusesOf(3)]: () => json(BUILT_THEN_FAILED),
      [statusesOf(4)]: () => json(STILL_RUNNING),
      [statusesOf(5)]: () => json(MIGRATE_ONLY),
    });
    assert.equal(await probe.liveSha(), OLD_SHA);
  });

  it("takes the newest deployment when it is fully done", async () => {
    const { probe } = probeWith({
      [DEPLOYMENTS]: () =>
        json([
          { id: 3, sha: NEW_SHA },
          { id: 1, sha: OLD_SHA },
        ]),
      [statusesOf(1)]: () => json(DEPLOY_DONE),
      [statusesOf(3)]: () => json(DEPLOY_DONE),
    });
    assert.equal(await probe.liveSha(), NEW_SHA);
  });

  it("does not call a database or ingress job live, because Vercel never built it", async () => {
    const { probe } = probeWith({
      [DEPLOYMENTS]: () => json([{ id: 3, sha: NEW_SHA }]),
      [statusesOf(3)]: () => json(MIGRATE_ONLY),
    });
    assert.equal(await probe.liveSha(), null);
  });

  it("does not call a release live while its job is still moving traffic or has failed", async () => {
    const running = probeWith({
      [DEPLOYMENTS]: () => json([{ id: 3, sha: NEW_SHA }]),
      [statusesOf(3)]: () => json(STILL_RUNNING),
    });
    assert.equal(await running.probe.liveSha(), null);
    const failed = probeWith({
      [DEPLOYMENTS]: () => json([{ id: 3, sha: NEW_SHA }]),
      [statusesOf(3)]: () => json(BUILT_THEN_FAILED),
    });
    assert.equal(await failed.probe.liveSha(), null);
  });

  it("still calls a release live after GitHub marks it inactive for a newer one", async () => {
    const { probe } = probeWith({
      [DEPLOYMENTS]: () => json([{ id: 1, sha: OLD_SHA }]),
      [statusesOf(1)]: () =>
        json([statusOf("inactive", "actor"), ...DEPLOY_DONE]),
    });
    assert.equal(await probe.liveSha(), OLD_SHA);
  });

  it("stops at the newest live deployment, so a failing read of an older one cannot hide it", async () => {
    const { probe, seen } = probeWith({
      [DEPLOYMENTS]: () =>
        json([
          { id: 5, sha: NEW_SHA },
          { id: 4, sha: MERGE_SHA },
          { id: 1, sha: OLD_SHA },
        ]),
      [statusesOf(4)]: () => json({}, 500),
      [statusesOf(5)]: () => json(DEPLOY_DONE),
    });
    assert.equal(await probe.liveSha(), NEW_SHA);
    assert.deepEqual(
      seen.filter((path) => path.includes("/statuses")),
      [statusesOf(5)]
    );
  });

  it("reads newest first and fails if it cannot tell whether a newer deployment is live", async () => {
    const { probe } = probeWith({
      [DEPLOYMENTS]: () =>
        json([
          { id: 5, sha: NEW_SHA },
          { id: 4, sha: MERGE_SHA },
        ]),
      [statusesOf(5)]: () => json({}, 500),
      [statusesOf(4)]: () => json(DEPLOY_DONE),
    });
    await assert.rejects(probe.liveSha(), {
      message: "GitHub read failed: HTTP 500.",
    });
  });

  it("fails loudly when GitHub refuses, rather than reporting nothing deployed", async () => {
    const { probe } = probeWith({ [DEPLOYMENTS]: () => json({}, 403) });
    await assert.rejects(probe.liveSha(), {
      message: "GitHub read failed: HTTP 403.",
    });
  });
});

describe("isAncestor", () => {
  const compare = `/repos/Acquisity/Acquisity/compare/${MERGE_SHA}...${NEW_SHA}?per_page=1`;
  const cases: [string, boolean][] = [
    ["ahead", true],
    ["identical", true],
    ["behind", false],
    ["diverged", false],
  ];

  for (const [status, expected] of cases) {
    it(`is ${expected} when the live commit is ${status}`, async () => {
      const { probe } = probeWith({ [compare]: () => json({ status }) });
      assert.equal(
        await probe.isAncestor("Acquisity/Acquisity", MERGE_SHA, NEW_SHA),
        expected
      );
    });
  }

  it("refuses a malformed repository or commit before any request", async () => {
    const { probe, seen } = probeWith({});
    await assert.rejects(probe.isAncestor("not a repo", MERGE_SHA, NEW_SHA));
    await assert.rejects(
      probe.isAncestor("Acquisity/Acquisity", "main", NEW_SHA)
    );
    assert.deepEqual(seen, []);
  });
});

describe("pull", () => {
  const path = "/repos/Acquisity/Acquisity/pulls/7";

  it("reports merged, open and closed pull requests", async () => {
    const merged = probeWith({
      [path]: () =>
        json({ merge_commit_sha: MERGE_SHA, merged: true, state: "closed" }),
    });
    assert.deepEqual(await merged.probe.pull("Acquisity/Acquisity", 7), {
      mergeSha: MERGE_SHA,
      number: 7,
      repo: "Acquisity/Acquisity",
      state: "merged",
    });
    const open = probeWith({
      [path]: () =>
        json({ merge_commit_sha: NEW_SHA, merged: false, state: "open" }),
    });
    assert.deepEqual(await open.probe.pull("Acquisity/Acquisity", 7), {
      mergeSha: null,
      number: 7,
      repo: "Acquisity/Acquisity",
      state: "open",
    });
    const closed = probeWith({
      [path]: () =>
        json({ merge_commit_sha: null, merged: false, state: "closed" }),
    });
    assert.equal(
      (await closed.probe.pull("Acquisity/Acquisity", 7)).state,
      "closed"
    );
  });
});

describe("deadline", () => {
  const never = () => new Promise<never>(() => undefined);

  it("covers token resolution, so a stalled token broker cannot hang a read", async () => {
    let requested = false;
    const probe = githubDeployProbe(
      never,
      () => {
        requested = true;
        return Promise.resolve(json([]));
      },
      40
    );
    await assert.rejects(probe.liveSha(), DeadlineError);
    await assert.rejects(probe.pull("Acquisity/Acquisity", 7), DeadlineError);
    await assert.rejects(
      probe.isAncestor("Acquisity/Acquisity", MERGE_SHA, NEW_SHA),
      DeadlineError
    );
    assert.equal(requested, false);
  });

  it("covers a request that never answers", async () => {
    const probe = githubDeployProbe(() => Promise.resolve("token"), never, 40);
    await assert.rejects(probe.liveSha(), DeadlineError);
  });
});

describe("overall scan deadline", () => {
  const slowProbe = (delayMs: number, scanMs: number, live?: number) => {
    const reads: string[] = [];
    const deployments = Array.from({ length: 30 }, (_, i) => ({
      id: 100 - i,
      sha: NEW_SHA,
    }));
    const probe = githubDeployProbe(
      () => Promise.resolve("token"),
      async (input: string | URL | Request) => {
        const url = String(input).replace("https://api.github.com", "");
        reads.push(url);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (url.includes("/statuses")) {
          return json(url.includes(`/${live}/`) ? DEPLOY_DONE : MIGRATE_ONLY);
        }
        return json(deployments);
      },
      1000,
      scanMs
    );
    return { probe, reads };
  };

  it("treats the live commit as unknown when slow reads use up the scan's time", async () => {
    const { probe, reads } = slowProbe(30, 120);
    assert.equal(await probe.liveSha(), null);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(
      reads.filter((path) => path.includes("/statuses")).length <= 6,
      "the scan stops reading once its deadline has passed"
    );
  });

  it("still returns a live commit found inside the deadline", async () => {
    const { probe } = slowProbe(10, 1000, 99);
    assert.equal(await probe.liveSha(), NEW_SHA);
  });

  it("still fails when a single read hangs, because that is not the scan running out of time", async () => {
    const probe = githubDeployProbe(
      () => Promise.resolve("token"),
      () => new Promise<never>(() => undefined),
      40,
      500
    );
    await assert.rejects(probe.liveSha(), DeadlineError);
  });
});
