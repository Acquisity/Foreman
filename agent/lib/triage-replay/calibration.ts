import { createHash } from "node:crypto";
import { z } from "zod";
import type { TriageResult } from "./schema.js";
import { ROOT_CAUSE_GRADES, type RootCauseGrade } from "./score.js";

export const handLabelsSchema = z
  .array(
    z.strictObject({
      documentSha256: z.string().regex(/^[0-9a-f]{64}$/u),
      grade: z.enum(ROOT_CAUSE_GRADES),
      reason: z.string().optional(),
      row: z.string().regex(/^ENG-\d+#\d+$/u),
    })
  )
  .superRefine((labels, ctx) => {
    if (new Set(labels.map(({ row }) => row)).size !== labels.length) {
      ctx.addIssue({ code: "custom", message: "One hand label per row." });
    }
  });
export type HandLabel = z.infer<typeof handLabelsSchema>[number];

export const documentSha256 = (result: Pick<TriageResult, "document">) =>
  result.document
    ? createHash("sha256").update(result.document.text).digest("hex")
    : null;

export interface Calibration {
  agreement: { agree: number; total: number };
  coverage: {
    labelled: number;
    measured: number;
    missing: number;
    stale: number;
  };
  flips: { flipped: number; total: number } | null;
}

const flipsBetween = (
  first: ReadonlyMap<string, RootCauseGrade>,
  second: ReadonlyMap<string, RootCauseGrade>
) => {
  const rows = [...first].filter(([row]) => second.has(row));
  return {
    flipped: rows.filter(([row, grade]) => second.get(row) !== grade).length,
    total: rows.length,
  };
};

export function calibrate(
  labels: readonly HandLabel[],
  results: ReadonlyMap<string, Pick<TriageResult, "document">>,
  first: ReadonlyMap<string, RootCauseGrade>,
  second?: ReadonlyMap<string, RootCauseGrade>
): Calibration {
  const calibration: Calibration = {
    agreement: { agree: 0, total: 0 },
    coverage: { labelled: labels.length, measured: 0, missing: 0, stale: 0 },
    flips: second ? flipsBetween(first, second) : null,
  };
  for (const label of labels) {
    const result = results.get(label.row);
    const grades = [first.get(label.row), second?.get(label.row)].slice(
      0,
      second ? 2 : 1
    );
    if (result && documentSha256(result) !== label.documentSha256) {
      calibration.coverage.stale += 1;
    } else if (result && grades[0] !== undefined) {
      calibration.coverage.measured += 1;
      calibration.agreement.total += grades.length;
      calibration.agreement.agree += grades.filter(
        (grade) => grade === label.grade
      ).length;
    } else {
      calibration.coverage.missing += 1;
    }
  }
  return calibration;
}

export const calibrated = ({ agreement, coverage, flips }: Calibration) =>
  coverage.labelled > 0 &&
  coverage.measured === coverage.labelled &&
  agreement.total > 0 &&
  agreement.agree / agreement.total >= 0.9 &&
  flips !== null &&
  flips.total > 0 &&
  flips.flipped / flips.total <= 0.05;

const rate = (part: number, whole: number) =>
  whole ? `${((part / whole) * 100).toFixed(1)}% (${part}/${whole})` : "n/a";

export function renderCalibration(calibration: Calibration): string {
  const { agreement, coverage, flips } = calibration;
  return [
    "## Judge calibration",
    "",
    `- Agreement with the hand labels: ${rate(agreement.agree, agreement.total)}.`,
    `- Flip rate on a rerun: ${flips ? rate(flips.flipped, flips.total) : "not measured (pass --rerun)"}.`,
    `- Hand labels: ${coverage.labelled}, measured ${coverage.measured}, stale ${coverage.stale} (another document than the one labelled), missing ${coverage.missing} (no judged row).`,
    `- Calibrated: ${calibrated(calibration) ? "yes" : "no"} (every label measured, at least 90% agreement, at most 5% flips).`,
    "",
  ].join("\n");
}
