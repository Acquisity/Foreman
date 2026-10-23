import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
  "/repos/Acquisity/Acquisity/deployments?environment=production&per_page=10";
const statusesOf = (id: number) =>
  `/repos/Acquisity/Acquisity/deployments/${id}/statuses?per_page=1`;

describe("liveSha", () => {
  it("is the newest production deployment whose latest status is success", async () => {
    const { probe } = probeWith({
      [DEPLOYMENTS]: () =>
        json([
          { id: 3, sha: NEW_SHA },
          { id: 2, sha: MERGE_SHA },
          { id: 1, sha: OLD_SHA },
        ]),
      [statusesOf(1)]: () => json([{ state: "success" }]),
      [statusesOf(2)]: () => json([{ state: "failure" }]),
      [statusesOf(3)]: () => json([{ state: "in_progress" }]),
    });
    assert.equal(await probe.liveSha(), OLD_SHA);
  });

  it("takes the newest deployment when it has succeeded", async () => {
    const { probe } = probeWith({
      [DEPLOYMENTS]: () =>
        json([
          { id: 3, sha: NEW_SHA },
          { id: 1, sha: OLD_SHA },
        ]),
      [statusesOf(1)]: () => json([{ state: "success" }]),
      [statusesOf(3)]: () => json([{ state: "success" }]),
    });
    assert.equal(await probe.liveSha(), NEW_SHA);
  });

  it("is null when nothing has succeeded, so nothing is called live", async () => {
    const { probe } = probeWith({
      [DEPLOYMENTS]: () => json([{ id: 3, sha: NEW_SHA }]),
      [statusesOf(3)]: () => json([]),
    });
    assert.equal(await probe.liveSha(), null);
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
