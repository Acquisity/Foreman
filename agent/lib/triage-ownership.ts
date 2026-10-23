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
  areaForProject,
  FALLBACK_AREA,
  FALLBACK_OWNER,
  hasLabel,
  isAreaKey,
  isCrmArea,
  NEEDS_APPROVAL_LABEL,
  ownerForArea,
  SUPPORT_OWNER,
  specificAreaForPath,
} from "./owner-map.js";

type Answers = Record<string, JevAnswer>;

const UNDETERMINED = "undetermined";
const SIGNAL_BAR = 0.5;

export interface Ownership {
  approval: "approved" | "needed" | "not-applicable";
  area: { key: AreaKey; label: string; matched: boolean } | null;
  assignee: string | null;
  path: HandlingPath;
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
    key = specificAreaForPath(codePath.file) ?? key;
  }
  return key
    ? { key, matched: !(key === FALLBACK_AREA) }
    : { key: FALLBACK_AREA, matched: false };
};

const isFeatureRequest = (
  classification: TriageClassification,
  answers: Answers
): boolean =>
  classification === "Platform Limitation" &&
  probabilityOf(answers.wants_limit_lifted) >= SIGNAL_BAR;

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
  const none: Ownership = {
    approval: "not-applicable",
    area: null,
    assignee: null,
    path,
  };
  if (input.identifier.toUpperCase().startsWith("SAN-")) {
    return { ...none, assignee: SUPPORT_OWNER };
  }
  const place = () => {
    const area = settledArea(
      answers,
      context.project,
      input.codePath,
      context.bar
    );
    return { ...area, label: AREAS[area.key].label };
  };
  if (classification === "Bug") {
    const area = place();
    const developer = duplicate || path === "Engineering Todo";
    if (developer && !area.matched) {
      notes.push(
        `The evidence does not place this in a mapped area, so it goes to ${FALLBACK_OWNER}; say which evidence is missing in the document.`
      );
    }
    return {
      ...none,
      area,
      assignee: developer ? ownerForArea(area.key) : null,
    };
  }
  if (!isFeatureRequest(classification, answers)) {
    return none;
  }
  if (!hasLabel(input.ticketLabels ?? [], APPROVED_LABEL)) {
    notes.push(
      `A feature request that nobody has approved gets no developer. It is labelled "${NEEDS_APPROVAL_LABEL}" for James to approve; add the "${APPROVED_LABEL}" label to release it.`
    );
    return { ...none, approval: "needed" };
  }
  if (path !== "Platform Limitation") {
    return { ...none, approval: "approved" };
  }
  const area = place();
  return {
    approval: "approved",
    area,
    assignee: ownerForArea(area.key),
    path: "Engineering Todo",
  };
}

export const ownershipRoute = (
  ownership: Ownership,
  labels: string[]
): { addLabels: string[]; assignee?: string; removeLabels?: string[] } => ({
  addLabels: [
    ...new Set([
      ...labels,
      ...(ownership.area ? [ownership.area.label] : []),
      ...(ownership.approval === "needed" ? [NEEDS_APPROVAL_LABEL] : []),
    ]),
  ],
  ...(ownership.approval === "approved"
    ? { removeLabels: [NEEDS_APPROVAL_LABEL] }
    : {}),
  ...(ownership.assignee ? { assignee: ownership.assignee } : {}),
});
