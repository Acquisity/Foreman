import type { RegressionRecord } from "./regression-record.js";

const BUG_DOCUMENT = /^\*\*Classification\*\*:\s*Bug\s*$/mu;

export const isBugDocument = (content: string): boolean =>
  BUG_DOCUMENT.test(content);
const SECTION = /^## Regression check\s*$([\s\S]*?)(?=^## |(?![\s\S]))/mu;
const NOT_APPLICABLE = /^\*\*Result\*\*:\s*Not applicable: Duplicate\b/mu;
const NOT_AVAILABLE = /^Not available: \S/u;

const DEPLOYED_LINE = /^\*\*Deployed commit\*\*:[ \t]*(.+?)[ \t]*$/mu;
const READ_LINE = /^\*\*Commit read\*\*:[ \t]*(.+?)[ \t]*$/mu;
const RESULT_LINE = /^\*\*Result\*\*:[ \t]*(.+?)[ \t]*$/mu;

/**
 * What a triage document must say about the regression check (ENG-16056):
 * for a Bug, the deployed commit, the commit read and the result, copied from
 * the session's check_regression record. A section that disagrees with that
 * record is refused, so a populated heading can't support a different result.
 * Returns the gaps, the same shape as the other document checks.
 */
export const regressionDocumentGaps = (
  content: string,
  record: RegressionRecord | undefined
): string[] => {
  if (!isBugDocument(content)) {
    return [];
  }
  const section = SECTION.exec(content)?.[1] ?? "";
  if (NOT_APPLICABLE.test(section)) {
    return [];
  }
  if (!record) {
    return [
      "a regression check: run check_regression for this ticket, then add its `## Regression check` section (or `**Result**: Not applicable: Duplicate of <ticket>` for a duplicate)",
    ];
  }
  const deployed = DEPLOYED_LINE.exec(section)?.[1] ?? null;
  const gaps = [
    deployed !== null &&
    (record.deployedCommit
      ? deployed === record.deployedCommit
      : NOT_AVAILABLE.test(deployed))
      ? null
      : `\`**Deployed commit**: ${record.deployedCommit ?? "Not available: <reason>"}\` under \`## Regression check\``,
    READ_LINE.exec(section)?.[1] === record.commitRead
      ? null
      : `\`**Commit read**: ${record.commitRead}\` under \`## Regression check\``,
    RESULT_LINE.exec(section)?.[1] === record.line
      ? null
      : `\`**Result**: ${record.line}\` under \`## Regression check\``,
  ];
  return gaps.filter((gap): gap is string => gap !== null);
};
