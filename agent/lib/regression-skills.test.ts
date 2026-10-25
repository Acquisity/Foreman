import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { HANDLING_PATHS } from "./jev-decisions.js";
import { lineFor } from "./regression-lane.js";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const reference = read(
  "skills/triage-investigate/references/regression-check.md"
);
const investigate = read("skills/triage-investigate/SKILL.md");
const handling = read("skills/triage-handling/SKILL.md");
const reporting = read("skills/triage-handling/references/reporting.md");
const criticReview = read("skills/triage-handling/references/critic-review.md");
const handoff = read("skills/engineering-handoff/SKILL.md");
const criticSkill = read("subagents/critic/skills/triage-critic/SKILL.md");
const criticTools = read(
  "subagents/critic/skills/triage-critic/references/tools.md"
);
const rootTools = read("skills/triage-investigate/references/tools.md");

const SHA = "<sha>";
const MOUNT = /tools\/check_regression\.js/u;

describe("the regression lane in the triage skills", () => {
  it("names every result line the tool can return, verbatim", () => {
    for (const kind of [
      "introduced",
      "fixed_live",
      "fixed_not_deployed",
      "fixed_deploy_unknown",
    ] as const) {
      assert.ok(reference.includes(lineFor(kind, SHA)), kind);
    }
    assert.ok(reference.includes("`none`"));
    assert.ok(reference.includes("`unchecked: <reason>`"));
  });

  it("sends a fixed bug to the paths the code returns, with no master", () => {
    assert.ok("Resolved by triage" in HANDLING_PATHS);
    assert.ok("Support/Product follow-up" in HANDLING_PATHS);
    assert.ok(reference.includes("`Resolved by triage`"));
    assert.ok(reference.includes("`Support/Product follow-up`"));
    assert.ok(!reference.includes("assignOwner"));
    assert.ok(
      reference.includes(
        "the decision's `route` already names the area owner, so pass it unchanged"
      )
    );
    assert.ok(
      reference.includes(
        "It closes as `Done`, not `Canceled`: the earlier fix is the change that was made."
      )
    );
    assert.ok(
      reference.includes(
        "link the pull request that merged the fixing commit with `route_ticket` `links`"
      )
    );
    assert.ok(reference.includes("No master, no engineering hand-off"));
    assert.ok(reference.includes("nothing for Devin"));
  });

  it("keeps the commit out of the requester comment", () => {
    assert.ok(reference.includes("without the commit"));
  });

  it("is loaded from Stage 4 and from Stage 5", () => {
    assert.ok(
      investigate.includes("references/regression-check.md") &&
        investigate.indexOf("### Check what changed and what production runs") >
          investigate.indexOf("### Locate it in the code") &&
        investigate.indexOf("### Check what changed and what production runs") <
          investigate.indexOf("### Check the data")
    );
    assert.ok(
      handling.includes("../triage-investigate/references/regression-check.md")
    );
    assert.ok(handling.includes("`check_regression`"));
    assert.ok(!handling.includes("assignOwner"));
    assert.ok(
      existsSync(
        new URL(
          "../skills/triage-investigate/references/regression-check.md",
          import.meta.url
        )
      )
    );
  });

  it("puts the regression check in the document template and the critic packet", () => {
    for (const field of ["Deployed commit", "Commit read", "Result"]) {
      assert.ok(reporting.includes(`**${field}**:`), field);
    }
    assert.ok(reporting.includes("## Regression check"));
    assert.ok(
      criticReview.includes("the regression result with the deployed commit")
    );
  });

  it("has the critic grade the result on reachability, and mounts the tool it needs", () => {
    const reachability = criticSkill.slice(
      criticSkill.indexOf("2. `reachability`"),
      criticSkill.indexOf("3. `causality`")
    );
    for (const grade of [
      "Regression: held",
      "Regression: disputed",
      "Regression: not checked",
    ]) {
      assert.ok(reachability.includes(grade), grade);
    }
    assert.ok(reachability.includes("`FAIL`"));
    assert.ok(criticTools.includes("`check_regression`"));
    assert.ok(rootTools.includes("`check_regression`"));
    assert.match(read("subagents/critic/tools/check_regression.ts"), MOUNT);
  });

  it("names the introducing commit in the master", () => {
    assert.ok(handoff.includes("`introduced by <commit>`"));
  });
});
