import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type EvalCase, evaluate, predictArea } from "./owner-eval.js";

const TICKET = /^ENG-\d+$/u;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/u;
const ACCURACY_LINE = /owner accuracy: (\d+) of (\d+)/u;

const fixtureUrl = new URL(
  "../../scripts/routing-eval.cases.json",
  import.meta.url
);
const cases = JSON.parse(readFileSync(fixtureUrl, "utf8")) as EvalCase[];

const sample = (over: Partial<EvalCase>): EvalCase => ({
  areaSource: "ticket-project",
  files: ["apps/web/lib/thing.ts"],
  project: "AI SDR Core",
  ticket: "ENG-1",
  trueArea: "ai-sdr",
  ...over,
});

describe("the routing eval", () => {
  it("ships a fixture of at least 100 plain past fixes with no customer text", () => {
    assert.ok(cases.length >= 100, `${cases.length} cases`);
    assert.equal(new Set(cases.map((c) => c.ticket)).size, cases.length);
    for (const item of cases) {
      assert.match(item.ticket, TICKET);
      assert.ok(item.trueArea, item.ticket);
    }
    assert.equal(EMAIL.test(readFileSync(fixtureUrl, "utf8")), false);
  });

  it("scores a right owner, a wrong owner and a missing project", () => {
    const summary = evaluate([
      sample({}),
      sample({ project: "Core Platform", ticket: "ENG-2" }),
      sample({ project: null, ticket: "ENG-3" }),
    ]);
    assert.equal(summary.cases, 3);
    assert.equal(summary.correct, 1);
    assert.deepEqual(
      summary.misses.map((miss) => [miss.ticket, miss.reason]),
      [
        ["ENG-2", "wrong owner"],
        ["ENG-3", "no project"],
      ]
    );
  });

  it("sends an unmapped project to James and splits CRM by the files a fix touched", () => {
    assert.equal(
      predictArea(sample({ project: "AI Website Builder" })),
      "other"
    );
    assert.equal(
      predictArea(
        sample({
          files: ["apps/web/components/notifications/card.tsx"],
          project: "CRM",
        })
      ),
      "crm_conversations"
    );
    assert.equal(
      predictArea(
        sample({ files: ["apps/web/lib/crm/schema.ts"], project: "CRM" })
      ),
      "crm_records"
    );
  });

  it("prints the same score from the script as from the library", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/routing-eval.ts"],
      { cwd: root, encoding: "utf8" }
    );
    const printed = ACCURACY_LINE.exec(output);
    const summary = evaluate(cases);
    assert.equal(Number(printed?.[1]), summary.correct);
    assert.equal(Number(printed?.[2]), summary.cases);
    assert.ok(output.includes("misses ("));
  });
});
