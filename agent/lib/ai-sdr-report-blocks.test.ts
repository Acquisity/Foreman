import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { renderAiSdrReportBlocks } from "./ai-sdr-report-blocks.js";
import type { AiSdrWeeklyReportResult } from "./ai-sdr-weekly-report.js";

type Report = Extract<AiSdrWeeklyReportResult, { success: true }>;
const report = JSON.parse(
  readFileSync(
    new URL("./fixtures/ai-sdr-weekly-report.json", import.meta.url),
    "utf8"
  )
) as Report;

const tableRows = (blocks: unknown[], index: number): string[][] =>
  (
    blocks.filter((block) => (block as { type: string }).type === "table")[
      index
    ] as { rows: { text: string }[][] }
  ).rows.map((row) => row.map((cell) => cell.text));

describe("renderAiSdrReportBlocks", () => {
  test("formats counts, percent changes and point changes the way the report always has", () => {
    const { blocks, text } = renderAiSdrReportBlocks(report);
    const volume = tableRows(blocks, 0);
    assert.deepEqual(volume[0], [
      "Metric",
      "This wk",
      "Last wk",
      "Δ WoW",
      "Same wk last month",
      "Δ MoM",
    ]);
    assert.deepEqual(volume[1], [
      "Emails sent",
      "1.57M",
      "1.52M",
      "+3.1%",
      "1.30M",
      "+21.0%",
    ]);
    assert.deepEqual(volume[5], [
      "Reply rate",
      "1.25%",
      "1.17%",
      "+0.08pp",
      "1.15%",
      "+0.10pp",
    ]);
    assert.ok(text.startsWith("AI SDR weekly report, 16 to 20 Nov 2026"));
  });

  test("shows n/a for a change from a zero baseline", () => {
    const zeroBaseline = structuredClone(report);
    zeroBaseline.volume.emailsSent.wowPercent = null;
    const volume = tableRows(renderAiSdrReportBlocks(zeroBaseline).blocks, 0);
    assert.equal(volume[1]?.[3], "n/a");
  });
});
