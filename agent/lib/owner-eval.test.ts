import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type EvalCase,
  evaluate,
  predictArea,
  truthArea,
} from "./owner-eval.js";

const TICKET = /^ENG-\d+$/u;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/u;
const ACCURACY_LINE = /owner accuracy: (\d+) of (\d+)/u;

const fixtureUrl = new URL(
  "../../scripts/routing-eval.cases.json",
  import.meta.url
);
const cases = JSON.parse(readFileSync(fixtureUrl, "utf8")) as EvalCase[];

const AI_SDR_FILE = "apps/web/lib/ai-sdr-v2/reply.ts";
const CONVERSATIONS_FILE = "apps/web/components/notifications/card.tsx";
const RECORDS_FILE = "apps/web/lib/crm/schema.ts";

const sample = (over: Partial<EvalCase>): EvalCase => ({
  files: [AI_SDR_FILE],
  project: "AI SDR Core",
  ticket: "ENG-1",
  ticketPaths: [],
  ...over,
});

describe("the routing eval", () => {
  it("ships a fixture of at least 100 plain past fixes with no customer text", () => {
    assert.ok(cases.length >= 100, `${cases.length} cases`);
    assert.equal(new Set(cases.map((c) => c.ticket)).size, cases.length);
    for (const item of cases) {
      assert.match(item.ticket, TICKET);
    }
    assert.equal(EMAIL.test(readFileSync(fixtureUrl, "utf8")), false);
  });

  it("takes the truth from the changed files, never from the project", () => {
    assert.equal(truthArea([AI_SDR_FILE]), "ai_sdr");
    assert.equal(truthArea([CONVERSATIONS_FILE]), "crm_conversations");
    assert.equal(
      truthArea([RECORDS_FILE, "apps/web/lib/utils.ts"]),
      "crm_records"
    );
    assert.equal(truthArea(["apps/web/lib/utils.ts"]), null);
    assert.equal(truthArea([AI_SDR_FILE, RECORDS_FILE]), null);
    const asCore = evaluate([sample({ project: "Core Platform" })]);
    const asSdr = evaluate([sample({ project: "AI SDR Core" })]);
    assert.equal(asCore.overall.correct, 0);
    assert.equal(asSdr.overall.correct, 1);
  });

  it("scores a right owner, a wrong owner and a ticket with no project and no path as a miss", () => {
    const summary = evaluate([
      sample({}),
      sample({ project: "Core Platform", ticket: "ENG-2" }),
      sample({ project: null, ticket: "ENG-3" }),
      sample({ files: ["apps/web/lib/utils.ts"], ticket: "ENG-4" }),
    ]);
    assert.equal(summary.cases, 4);
    assert.equal(summary.ambiguous, 1);
    assert.deepEqual(summary.overall, { correct: 1, total: 3 });
    assert.deepEqual(summary.withProject, { correct: 1, total: 2 });
    assert.deepEqual(summary.withoutProject, { correct: 0, total: 1 });
    assert.deepEqual(
      summary.misses.map((miss) => [miss.ticket, miss.reason]),
      [
        ["ENG-2", "wrong owner"],
        ["ENG-3", "no project and no path"],
      ]
    );
  });

  it("credits only the one owner the map gives a CRM sub-area", () => {
    const summary = evaluate([
      sample({ files: [CONVERSATIONS_FILE], project: "CRM" }),
      sample({
        files: [CONVERSATIONS_FILE],
        project: "CRM",
        ticket: "ENG-2",
        ticketPaths: [CONVERSATIONS_FILE],
      }),
      sample({ files: [RECORDS_FILE], project: "CRM", ticket: "ENG-3" }),
    ]);
    assert.deepEqual(summary.byCrmArea.crm_conversations, {
      correct: 1,
      total: 2,
    });
    assert.deepEqual(summary.byCrmArea.crm_records, { correct: 1, total: 1 });
    assert.deepEqual(
      summary.misses.map((miss) => [miss.ticket, miss.predictedOwner]),
      [["ENG-1", "Ebubeker Rexha"]]
    );
  });

  it("routes a ticket with no project only from paths its own text names", () => {
    const fixOnly = sample({ files: [CONVERSATIONS_FILE], project: null });
    assert.equal(predictArea(fixOnly), null);
    assert.equal(
      predictArea({ ...fixOnly, ticketPaths: [CONVERSATIONS_FILE] }),
      "crm_conversations"
    );
    assert.equal(
      predictArea(sample({ project: "AI Website Builder" })),
      "other"
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
    assert.equal(Number(printed?.[1]), summary.overall.correct);
    assert.equal(Number(printed?.[2]), summary.overall.total);
    assert.ok(output.includes("misses ("));
  });
});
