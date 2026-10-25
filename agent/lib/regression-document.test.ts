import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { regressionDocumentGaps } from "./regression-document.js";
import type { RegressionRecord } from "./regression-record.js";

const RUN_TOOL = /run check_regression/u;
const READ = "a".repeat(40);
const DEPLOYED = "d".repeat(40);
const FIX = "f".repeat(40);

const record = (over: Partial<RegressionRecord> = {}): RegressionRecord => ({
  commit: FIX,
  commitRead: READ,
  deployedCommit: DEPLOYED,
  issue: "ENG-1",
  kind: "fixed_live",
  line: `fixed on main and live, by ${FIX}`,
  windowDays: 30,
  ...over,
});

const makeDocument = (body: string, classification = "Bug") =>
  `# Triage investigation\n\n**Ticket**: ENG-1\n**Classification**: ${classification}\n**Review**: Pending critic\n\n## Claim\nIt broke.\n\n${body}\n## Code path\nsend.ts at ${READ}\n`;

interface SectionOver {
  deployed?: string;
  read?: string;
  result?: string;
}

const makeSection = (over: SectionOver = {}) =>
  [
    "## Regression check",
    `**Deployed commit**: ${over.deployed ?? DEPLOYED}`,
    `**Commit read**: ${over.read ?? READ}`,
    `**Result**: ${over.result ?? `fixed on main and live, by ${FIX}`}`,
    "",
  ].join("\n");

describe("regression section of a Bug document", () => {
  it("accepts a section that repeats the tool's record", () => {
    assert.deepEqual(
      regressionDocumentGaps(makeDocument(makeSection()), record()),
      []
    );
  });

  it("refuses a Bug document with no section, or no record to back it", () => {
    assert.equal(regressionDocumentGaps(makeDocument(""), record()).length, 3);
    const noRecord = regressionDocumentGaps(
      makeDocument(makeSection()),
      undefined
    );
    assert.equal(noRecord.length, 1);
    assert.match(noRecord[0] as string, RUN_TOOL);
  });

  it("refuses a section that disagrees with the record", () => {
    for (const over of [
      { read: "b".repeat(40) },
      { deployed: "c".repeat(40) },
      { result: "none" },
      { result: `introduced by ${FIX}` },
    ]) {
      assert.equal(
        regressionDocumentGaps(makeDocument(makeSection(over)), record())
          .length,
        1,
        JSON.stringify(over)
      );
    }
  });

  it("takes Not available only for a deployed commit the record does not have", () => {
    const unknown = record({
      deployedCommit: null,
      kind: "fixed_deploy_unknown",
      line: `fixed on main, deploy status unknown, by ${FIX}`,
    });
    const text = makeSection({
      deployed: "Not available: Vercel did not return the project",
      result: unknown.line,
    });
    assert.deepEqual(regressionDocumentGaps(makeDocument(text), unknown), []);
    assert.equal(
      regressionDocumentGaps(makeDocument(text), record()).length,
      2
    );
  });

  it("lets a duplicate say it does not apply, and ignores other classifications", () => {
    const duplicate = makeDocument(
      "## Regression check\n**Result**: Not applicable: Duplicate of ENG-9\n"
    );
    assert.deepEqual(regressionDocumentGaps(duplicate, undefined, true), []);
    assert.equal(regressionDocumentGaps(duplicate, undefined).length, 1);
    assert.equal(regressionDocumentGaps(duplicate, record(), false).length, 3);
    assert.deepEqual(
      regressionDocumentGaps(makeDocument("", "User Error"), undefined),
      []
    );
    assert.deepEqual(
      regressionDocumentGaps(makeDocument("", "Not settled"), undefined),
      []
    );
  });
});
