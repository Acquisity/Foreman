import { regressionDocumentGaps } from "./regression-document.js";
import type { RegressionRecord } from "./regression-record.js";

const SCORE = "(?:0(?:\\.\\d+)?|1(?:\\.0+)?)";
const CONFIDENCE_LINE = new RegExp(
  `^\\*\\*Confidence\\*\\*: (?:verdict ${SCORE}, classification ${SCORE}, path ${SCORE}|Not available: \\S.*)$`,
  "mu"
);
const REVIEW_LINE =
  /^\*\*Review\*\*: (?:Pending critic|Approved \S.*|Adjudicated \S.*|Blocked \S.*|Stopped: \S.*|Not required: \S.*)$/mu;

export const triageDocumentGaps = (
  content: string,
  regression?: RegressionRecord
): string[] => [
  ...(CONFIDENCE_LINE.test(content)
    ? []
    : [
        "a `**Confidence**: verdict <n>, classification <n>, path <n>` line copied from the decision (or `**Confidence**: Not available: <reason>`)",
      ]),
  ...(REVIEW_LINE.test(content)
    ? []
    : [
        "a `**Review**:` line with the critic's result, or `Not required: <reason>`",
      ]),
  ...regressionDocumentGaps(content, regression),
];
