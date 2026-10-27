import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { facts, MERGE_SHA, NEW_SHA, merged as pull } from "./fakes.js";
import {
  changeKindOf,
  closureOf,
  DEPLOY_REPOSITORY,
  deployVerdict,
  parsePullUrl,
  pullContext,
} from "./plan.js";

const PR_7638: { body: string; title: string } = JSON.parse(
  readFileSync(new URL("./fixtures/pr-7638.json", import.meta.url), "utf8")
);
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

  it("sends a Done ticket with no code and no label to the done-without-change check", () => {
    assert.deepEqual(closureOf(facts({ stateType: "completed" })), {
      kind: "done_without_pull",
    });
  });

  it("answers a Canceled ticket labelled User Error or Platform Limitation as not a bug, and any other as closed", () => {
    for (const label of ["User Error", "Platform Limitation"]) {
      assert.deepEqual(
        closureOf(
          facts({
            labels: [label],
            stateName: "Canceled",
            stateType: "canceled",
          })
        ),
        { kind: "not_fixed", reason: "not_a_bug" }
      );
    }
    assert.deepEqual(
      closureOf(facts({ stateName: "Canceled", stateType: "canceled" })),
      { kind: "not_fixed", reason: "closed" }
    );
  });

  it("answers a Done ticket that is labelled both Bug and User Error and has no code, instead of holding it", () => {
    for (const label of ["User Error", "Platform Limitation"]) {
      assert.deepEqual(
        closureOf(facts({ labels: ["Bug", label], stateType: "completed" })),
        { kind: "not_fixed", reason: "not_a_bug" },
        label
      );
    }
  });

  it("answers a no-code label even when the ticket also has a master", () => {
    assert.deepEqual(
      closureOf(
        facts({
          labels: ["User Error"],
          parent: { identifier: "ENG-9", stateType: "completed" },
          stateType: "started",
        })
      ),
      { kind: "not_fixed", reason: "not_a_bug" }
    );
  });

  it("still deploys first when the ticket has a linked fix, whatever its labels", () => {
    assert.equal(
      closureOf(
        facts({
          labels: ["User Error"],
          pullUrls: [PR],
          stateType: "completed",
        })
      ).kind,
      "needs_deploy"
    );
  });

  it("sends a Done bug with no linked pull request to the done-without-change check, never to fixed", () => {
    assert.deepEqual(
      closureOf(facts({ labels: ["Bug"], stateType: "completed" })),
      { kind: "done_without_pull" }
    );
  });
});

describe("changeKindOf", () => {
  it("reads Feature Request as a feature and Bug as a bug, whatever the title", () => {
    assert.equal(
      changeKindOf(["Feature Request"], [pull({ title: "fix: x" })]),
      "feature"
    );
    assert.equal(changeKindOf(["Bug"], [pull({ title: "feat: x" })]), "bug");
  });

  it("falls back to the merged pull request title, and calls anything else a fix", () => {
    assert.equal(changeKindOf([], [pull({ title: PR_7638.title })]), "feature");
    assert.equal(changeKindOf([], [pull({ title: "fix(crm): x" })]), "bug");
    assert.equal(
      changeKindOf([], [pull({ state: "closed", title: "feat: x" })]),
      "bug"
    );
    assert.equal(changeKindOf([], []), "bug");
  });
});

describe("pullContext", () => {
  it("keeps only the Solution and How it works sections of a real description, without the diagram", () => {
    const context = pullContext(PR_7638.body);
    assert.ok(context.startsWith("## Solution"));
    assert.ok(context.includes("Add Email to the existing next-step controls"));
    assert.ok(
      context.includes("### Power Dialer wrap-up and completed-call dock")
    );
    for (const dropped of [
      "## Problem",
      "## Verification",
      "mermaid",
      "codesmith",
      "Blast radius",
      "Closes ENG-15846",
    ]) {
      assert.ok(!context.includes(dropped), dropped);
    }
  });

  it("is empty when the description has neither section", () => {
    assert.equal(pullContext("## Problem\nSomething.\n## Notes\nNone."), "");
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
