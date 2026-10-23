import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Stage } from "./copy.js";
import { facts, MERGE_SHA, NEW_SHA } from "./fakes.js";
import {
  closureOf,
  DEPLOY_REPOSITORY,
  deployVerdict,
  type PullFacts,
  parsePullUrl,
  planEarly,
} from "./plan.js";

const pull = (over: Partial<PullFacts> = {}): PullFacts => ({
  mergeSha: MERGE_SHA,
  number: 7,
  repo: DEPLOY_REPOSITORY,
  state: "merged",
  ...over,
});
const PR = `https://github.com/${DEPLOY_REPOSITORY}/pull/7`;

describe("closureOf", () => {
  it("treats an unfinished ticket as open", () => {
    assert.deepEqual(closureOf(facts()), { kind: "open" });
  });

  it("sends a Done ticket with a linked pull request to the deploy check", () => {
    assert.deepEqual(
      closureOf(facts({ pullUrls: [PR], stateType: "completed" })),
      { kind: "needs_deploy", pullUrls: [PR] }
    );
  });

  it("follows the master when the master is Done and the ticket is not", () => {
    const closure = closureOf(
      facts({
        parent: { identifier: "ENG-9", stateType: "completed" },
        pullUrls: [PR],
      })
    );
    assert.equal(closure.kind, "needs_deploy");
  });

  it("ignores a master that is still open", () => {
    assert.equal(
      closureOf(
        facts({
          parent: { identifier: "ENG-9", stateType: "started" },
          pullUrls: [PR],
        })
      ).kind,
      "open"
    );
  });

  it("answers a duplicate straight away, with no deploy check", () => {
    assert.deepEqual(
      closureOf(facts({ stateName: "Duplicate", stateType: "canceled" })),
      { kind: "not_fixed", reason: "duplicate" }
    );
  });

  it("answers a Done ticket with no code as not a bug when triage labelled it so", () => {
    assert.deepEqual(
      closureOf(facts({ labels: ["User Error"], stateType: "completed" })),
      { kind: "not_fixed", reason: "not_a_bug" }
    );
    assert.deepEqual(
      closureOf(
        facts({ labels: ["Platform Limitation"], stateType: "completed" })
      ),
      { kind: "not_fixed", reason: "not_a_bug" }
    );
  });

  it("gives a plain no-change answer to a Done ticket with no code and no label", () => {
    assert.deepEqual(closureOf(facts({ stateType: "completed" })), {
      kind: "not_fixed",
      reason: "closed",
    });
  });

  it("holds a Done bug that has no linked pull request instead of calling it not fixed", () => {
    assert.deepEqual(
      closureOf(facts({ labels: ["Bug"], stateType: "completed" })),
      { kind: "held", why: "no_linked_pull" }
    );
  });
});

describe("deployVerdict", () => {
  const ancestors = (value: boolean) => new Map([[MERGE_SHA, value]]);

  it("is live only when the merge commit is an ancestor of the live commit", () => {
    assert.equal(deployVerdict([pull()], NEW_SHA, ancestors(true)), "live");
    assert.equal(deployVerdict([pull()], NEW_SHA, ancestors(false)), "waiting");
  });

  it("waits while the pull request is open or the live commit is unknown", () => {
    assert.equal(
      deployVerdict(
        [pull({ mergeSha: null, state: "open" })],
        NEW_SHA,
        ancestors(true)
      ),
      "waiting"
    );
    assert.equal(deployVerdict([pull()], null, ancestors(true)), "waiting");
  });

  it("ignores a pull request closed without merging", () => {
    assert.equal(
      deployVerdict(
        [pull({ mergeSha: null, number: 6, state: "closed" }), pull()],
        NEW_SHA,
        ancestors(true)
      ),
      "live"
    );
    assert.equal(
      deployVerdict(
        [pull({ mergeSha: null, state: "closed" })],
        NEW_SHA,
        ancestors(true)
      ),
      "held"
    );
  });

  it("needs every merged pull request to be live", () => {
    const other = pull({ mergeSha: NEW_SHA, number: 8 });
    const map = new Map([
      [MERGE_SHA, true],
      [NEW_SHA, false],
    ]);
    assert.equal(deployVerdict([pull(), other], NEW_SHA, map), "waiting");
  });

  it("does not guess for a repository with no deploy signal", () => {
    assert.equal(
      deployVerdict(
        [pull({ repo: "Acquisity/other" })],
        NEW_SHA,
        ancestors(true)
      ),
      "unsupported"
    );
  });
});

describe("planEarly", () => {
  const none = new Set<Stage>();

  it("sends one received message that names the owner when there is one", () => {
    const planned = planEarly(facts(), none, true);
    assert.deepEqual(planned?.covers, ["received", "owner"]);
    assert.ok(planned?.text.includes("Sam is looking after it"));
  });

  it("does not name an owner while the ticket is still in triage", () => {
    const planned = planEarly(facts({ stateType: "triage" }), none, true);
    assert.deepEqual(planned?.covers, ["received"]);
    assert.ok(!planned?.text.includes("Sam"));
  });

  it("sends a separate owner message once the ticket is routed", () => {
    const planned = planEarly(facts(), new Set<Stage>(["received"]), true);
    assert.equal(planned?.stage, "owner");
    assert.ok(
      planned?.text.startsWith("Sam is now looking after your report.")
    );
  });

  it("sends nothing more once both are done, or when naming the owner is off", () => {
    assert.equal(
      planEarly(facts(), new Set<Stage>(["received", "owner"]), true),
      null
    );
    assert.equal(planEarly(facts(), new Set<Stage>(["received"]), false), null);
    assert.deepEqual(planEarly(facts(), none, false)?.covers, ["received"]);
  });

  it("sends no owner message when nobody is assigned", () => {
    assert.equal(
      planEarly(facts({ assignee: null }), new Set<Stage>(["received"]), true),
      null
    );
  });
});

describe("parsePullUrl", () => {
  it("reads a pull request address and refuses anything else", () => {
    assert.deepEqual(parsePullUrl(PR), { number: 7, repo: DEPLOY_REPOSITORY });
    assert.equal(
      parsePullUrl("https://github.com/Acquisity/Acquisity/issues/7"),
      null
    );
    assert.equal(
      parsePullUrl("https://example.com/Acquisity/Acquisity/pull/7"),
      null
    );
  });
});
