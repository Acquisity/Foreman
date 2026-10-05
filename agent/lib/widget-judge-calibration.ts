import { writeFileSync } from "node:fs";
import { z } from "zod";
import { leaks } from "./widget-graders.js";
import {
  claimsFor,
  type JudgeRecord,
  judgeRecordSchema,
} from "./widget-judge.js";

export const goldSchema = z
  .array(
    z
      .strictObject({
        labels: z.array(
          z.strictObject({
            claim: z.string().min(1),
            expected: z.enum(["yes", "no"]),
            id: z.string().min(1),
          })
        ),
        sample: judgeRecordSchema,
      })
      .superRefine((entry, ctx) => {
        const unique = new Set(entry.labels.map((label) => label.id));
        if (
          unique.size !== entry.labels.length ||
          entry.labels.some(
            (label) =>
              !entry.sample.verdicts.some(
                (v) => v.id === label.id && v.claim === label.claim
              )
          )
        ) {
          ctx.addIssue({
            code: "custom",
            message: "Gold labels must identify unique reviewed claims.",
          });
        }
      })
  )
  .superRefine((entries, ctx) => {
    if (
      new Set(entries.map((entry) => entry.sample.case)).size !== entries.length
    ) {
      ctx.addIssue({ code: "custom", message: "Duplicate gold cases." });
    }
  });
export type GoldEntry = z.infer<typeof goldSchema>[number];

/** Preserve the exact reviewed sample; right keeps a verdict and wrong flips it. */
export function toGold(
  records: JudgeRecord[],
  marks: Map<string, boolean>
): GoldEntry[] {
  return goldSchema.parse(
    records.map((input) => {
      const sample = judgeRecordSchema.parse(input);
      const labels = sample.verdicts.flatMap((v) => {
        const right = marks.get(`${sample.case}#${v.id}`);
        const flipped = v.verdict === "yes" ? "no" : "yes";
        return right === undefined
          ? []
          : [
              {
                claim: v.claim,
                expected: right ? v.verdict : flipped,
                id: v.id,
              },
            ];
      });
      return { labels, sample };
    })
  );
}

/** A relabelled sample replaces its case; other reviewed samples remain. */
export const mergeGold = (old: GoldEntry[], next: GoldEntry[]) => [
  ...old.filter(
    (entry) => !next.some((item) => item.sample.case === entry.sample.case)
  ),
  ...next,
];

/** Validate every answer before the first tracked write. Never change reviewed text. */
export function writeGold(path: string, entries: GoldEntry[]) {
  const gold = goldSchema.parse(entries);
  for (const { sample } of gold) {
    if (leaks(sample.answer, sample.recorded).length) {
      throw new Error(
        `Gold not saved: answer for ${sample.case} contains identifiers or internal information.`
      );
    }
  }
  writeFileSync(path, `${JSON.stringify(gold, null, 2)}\n`);
}

export interface ClaimScore {
  agreement: { agree: number; total: number };
  coverage: {
    required: number;
    measured: number;
    stale: number;
    missing: number;
    unlabelled: number;
  };
  flips: { flipped: number; total: number };
}

/** Shared claims aggregate; a case's own ordinal is meaningful only within that case. */
const scoreKey = (name: string, id: string) =>
  id.startsWith("case-") ? `${name}#${id}` : id;

/** Each required sample/claim needs a current label and both verdicts before it is measured. */
export function scoreAgainstGold(
  gold: GoldEntry[],
  first: Map<string, JudgeRecord>,
  second: Map<string, JudgeRecord>
): Map<string, ClaimScore> {
  const scores = new Map<string, ClaimScore>();
  for (const { sample, labels } of gold) {
    const required = claimsFor(sample.recorded);
    const a = first.get(sample.case)?.verdicts ?? [];
    const b = second.get(sample.case)?.verdicts ?? [];
    const ids = new Set([...required, ...labels, ...a, ...b].map((c) => c.id));
    for (const id of ids) {
      const key = scoreKey(sample.case, id);
      const score = scores.get(key) ?? {
        agreement: { agree: 0, total: 0 },
        coverage: {
          measured: 0,
          missing: 0,
          required: 0,
          stale: 0,
          unlabelled: 0,
        },
        flips: { flipped: 0, total: 0 },
      };
      scores.set(key, score);
      const claim = required.find((c) => c.id === id);
      const label = labels.find((c) => c.id === id);
      const left = a.find((c) => c.id === id);
      const right = b.find((c) => c.id === id);
      score.coverage.required += 1;
      if (!label) {
        score.coverage.unlabelled += 1;
      } else if (
        !claim ||
        label.claim !== claim.text ||
        (left && left.claim !== label.claim) ||
        (right && right.claim !== label.claim)
      ) {
        score.coverage.stale += 1;
      } else if (left && right) {
        score.coverage.measured += 1;
        score.agreement.total += 2;
        score.agreement.agree +=
          Number(left.verdict === label.expected) +
          Number(right.verdict === label.expected);
        score.flips.total += 1;
        score.flips.flipped += Number(left.verdict !== right.verdict);
      } else {
        score.coverage.missing += 1;
      }
    }
  }
  return scores;
}

/** Insufficient coverage is a failed calibration, independent of agreement and stability. */
export const calibrated = (score: ClaimScore) =>
  score.coverage.required > 0 &&
  score.coverage.measured === score.coverage.required &&
  score.agreement.total > 0 &&
  score.flips.total > 0 &&
  score.agreement.agree / score.agreement.total >= 0.9 &&
  score.flips.flipped / score.flips.total <= 0.05;
