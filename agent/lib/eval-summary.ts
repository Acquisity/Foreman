import { z } from "zod";

const SUMMARY_CHARS = 4000;
const ERROR_CHARS = 500;
const ENV_LINE = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/u;
const count = z.number().int().nonnegative();
const reportSchema = z.object({
  failed: count,
  passed: count,
  results: z.array(
    z.object({
      assertions: z.array(
        z.object({
          message: z.string().optional(),
          name: z.string(),
          passed: z.boolean(),
        })
      ),
      error: z.string().optional(),
      id: z
        .string()
        .min(1)
        .max(256)
        .regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/u),
      verdict: z.enum(["passed", "failed", "scored", "skipped"]),
    })
  ),
  scored: count,
  skipped: count,
});

const diagnostic = (value: string) =>
  value
    .split("\n")
    .filter((line) => !ENV_LINE.test(line))
    .join(" ")
    .trim()
    .slice(0, ERROR_CHARS);

/** Projects eve eval --json, excluding logs, environment, traces and metadata. */
export const summarizeEval = (exitCode: number, stdout: string) => {
  // pnpm and dev-server output can precede the final, pretty-printed JSON.
  // Only top-level braces are unindented in eve's report.
  const start = stdout.lastIndexOf("\n{") + 1;
  const end = stdout.lastIndexOf("\n}");
  let report: z.infer<typeof reportSchema> | undefined;
  try {
    const parsed = reportSchema.safeParse(
      JSON.parse(
        end >= start ? stdout.slice(start, end + 2) : stdout.slice(start).trim()
      )
    );
    if (parsed.success) {
      report = parsed.data;
    }
  } catch {
    // Boot failures and shell timeouts do not produce a report.
  }
  if (!report) {
    const error =
      exitCode === 124 || exitCode === 137
        ? "Eval command exceeded its shell timeout."
        : `Eval command exited ${exitCode} without a valid JSON report.`;
    return { exitCode, firstError: error, success: false, summary: error };
  }
  const failure = report.results.find(
    (result) => result.error || result.assertions.some((item) => !item.passed)
  );
  const assertion = failure?.assertions.find((item) => !item.passed);
  const firstError =
    exitCode === 0
      ? null
      : diagnostic(
          assertion?.message ||
            assertion?.name ||
            failure?.error ||
            `Eval command exited ${exitCode}.`
        ) || "Eval failed.";
  const counts = `Results: ${report.passed} passed, ${report.failed} failed, ${report.scored} scored, ${report.skipped} skipped (${report.results.length} total)`;
  const verdicts = report.results
    .map((result) => `${result.id}: ${result.verdict}`)
    .join("\n")
    .slice(0, SUMMARY_CHARS - counts.length - 1);
  return {
    exitCode,
    firstError,
    success: exitCode === 0,
    summary: [verdicts, counts].filter(Boolean).join("\n"),
  };
};
