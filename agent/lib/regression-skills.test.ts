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

describe("the regression lane reads only what it can prove", () => {
  it("reads production's commit from GitHub, never Vercel READY times, and takes only a line range", () => {
    const regressionLines = (text: string) =>
      text
        .split("\n")
        .filter((line) => line.includes("check_regression"))
        .join("\n");
    for (const surface of [
      reference,
      regressionLines(rootTools),
      regressionLines(criticTools),
      regressionLines(criticSkill),
      regressionLines(reporting),
    ]) {
      assert.ok(!surface.includes("foreman_vercel_api"), "no Vercel read");
      assert.ok(!surface.includes("timeline"), "no deployment timeline");
      assert.ok(!surface.includes("readyAt"), "no READY timestamps");
    }
    assert.ok(!reference.includes("needle"));
    assert.ok(
      reference.includes(
        "`check_regression` reads the commit production serves from Acquisity/Acquisity's GitHub production deployments itself"
      )
    );
    assert.ok(
      reference.includes(
        "a fix that was on main before the failure time is `unchecked`"
      )
    );
    assert.ok(
      reference.includes(
        "The record answers only for the file, function, line range, commit read and failure time you passed"
      )
    );
    assert.ok(
      reference.includes(
        "Pass `decide_triage` the same file, function, line range (`codePath.lines`) and commit, and the same `failureAt`"
      )
    );
  });
});

describe("unavailable commits", () => {
  it("are described as a patchless merge or a patch too long, never labelled, and able to leave the result unchecked", () => {
    const tool = read("tools/check_regression.ts");
    const rule =
      "an unavailable commit is a merge git shows no patch for or a patch too long to show whole: never label it, and if it is newer than the deciding commit the result is `unchecked`";
    assert.ok(reference.includes(rule));
    assert.ok(tool.includes(rule.replaceAll("`", "")));
    for (const surface of [reference, tool]) {
      assert.ok(
        !surface.includes("unavailable are merges git shows no patch for")
      );
      assert.ok(
        !surface.includes("`unavailable` are merges git shows no patch for")
      );
    }
  });
});
