import {
  choiceOf,
  type JevAnswer,
  type JevQuestion,
  probabilityOf,
} from "./jev.js";
import type {
  HandlingPath,
  TriageClassification,
  TriageInput,
} from "./jev-decisions.js";
import {
  APPROVED_LABEL,
  AREA_KEYS,
  AREAS,
  type AreaKey,
  areaForPath,
  areaForProject,
  FALLBACK_AREA,
  FALLBACK_OWNER,
  hasLabel,
  isAreaKey,
  isCrmArea,
  NEEDS_APPROVAL_LABEL,
  ownerForArea,
  SUPPORT_OWNER,
} from "./owner-map.js";

type Answers = Record<string, JevAnswer>;

const UNDETERMINED = "undetermined";
const SIGNAL_BAR = 0.5;

export interface Ownership {
  approval: "approved" | "needed" | "not-applicable";
  area: { key: AreaKey; label: string; matched: boolean } | null;
  assignee: string | null;
}

export const areaQuestion = (): JevQuestion => ({
  criteria: {
    ...Object.fromEntries(
      AREA_KEYS.filter((key) => key !== FALLBACK_AREA).map((key) => [
        key,
        AREAS[key].description,
      ])
    ),
    [FALLBACK_AREA]: AREAS[FALLBACK_AREA].description,
    [UNDETERMINED]:
      "the evidence does not establish which area owns the root cause",
  },
  instructions:
    "Which product area owns the confirmed root cause and the code path it runs through? Judge from the evidence, never from the ticket title or its incoming project.",
  type: "choice",
});

const settledArea = (
  answers: Answers,
  project: string | null,
  codePath: TriageInput["codePath"],
  bar: number
): { key: AreaKey; matched: boolean } => {
  const answer = answers.area ? choiceOf(answers.area) : null;
  let key: AreaKey | null =
    answer &&
    answer.choice !== UNDETERMINED &&
    isAreaKey(answer.choice) &&
    answer.confidence >= bar
      ? answer.choice
      : null;
  if (!key && project) {
    key = areaForProject(project);
  }
  if (key && isCrmArea(key) && codePath) {
    key = areaForPath(codePath.file) ?? key;
  }
  return key
    ? { key, matched: !(key === FALLBACK_AREA) }
    : { key: FALLBACK_AREA, matched: false };
};

const developerEligibility = (
  classification: TriageClassification,
  path: HandlingPath,
  duplicate: boolean,
  input: TriageInput,
  answers: Answers
): "approved" | "bug" | "needed" | "none" => {
  if (classification === "Bug" && (duplicate || path === "Engineering Todo")) {
    return "bug";
  }
  const featureRequest =
    classification === "Platform Limitation" &&
    probabilityOf(answers.wants_limit_lifted) >= SIGNAL_BAR;
  if (!featureRequest) {
    return "none";
  }
  return hasLabel(input.ticketLabels ?? [], APPROVED_LABEL)
    ? "approved"
    : "needed";
};

export function resolveOwnership(context: {
  answers: Answers;
  bar: number;
  classification: TriageClassification;
  duplicate: boolean;
  input: TriageInput;
  notes: string[];
  path: HandlingPath;
  project: string | null;
}): Ownership {
  const { answers, classification, duplicate, input, notes, path } = context;
  if (input.identifier.toUpperCase().startsWith("SAN-")) {
    return { approval: "not-applicable", area: null, assignee: SUPPORT_OWNER };
  }
  const eligibility = developerEligibility(
    classification,
    path,
    duplicate,
    input,
    answers
  );
  if (eligibility === "needed") {
    notes.push(
      `A feature request that nobody has approved gets no developer. It is labelled "${NEEDS_APPROVAL_LABEL}" for James to approve; add the "${APPROVED_LABEL}" label to release it.`
    );
    return { approval: "needed", area: null, assignee: null };
  }
  if (eligibility === "none" && classification !== "Bug") {
    return { approval: "not-applicable", area: null, assignee: null };
  }
  const { key, matched } = settledArea(
    answers,
    context.project,
    input.codePath,
    context.bar
  );
  if (!matched && eligibility !== "none") {
    notes.push(
      `The evidence does not place this in a mapped area, so it goes to ${FALLBACK_OWNER}; say which evidence is missing in the document.`
    );
  }
  return {
    approval: eligibility === "approved" ? "approved" : "not-applicable",
    area: { key, label: AREAS[key].label, matched },
    assignee: eligibility === "none" ? null : ownerForArea(key),
  };
}

export const ownershipRoute = (
  ownership: Ownership,
  labels: string[]
): { addLabels: string[]; assignee?: string } => ({
  addLabels: [
    ...new Set([
      ...labels,
      ...(ownership.area ? [ownership.area.label] : []),
      ...(ownership.approval === "needed" ? [NEEDS_APPROVAL_LABEL] : []),
    ]),
  ],
  ...(ownership.assignee ? { assignee: ownership.assignee } : {}),
});
