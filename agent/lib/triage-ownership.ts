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

const PARKABLE_PATHS: readonly HandlingPath[] = [
  "Backlog/low-impact",
  "Engineering Todo",
  "Platform Limitation",
];

const UNDETERMINED = "undetermined";
const SIGNAL_BAR = 0.5;

export interface Ownership {
  approval: "approved" | "needed" | "not-applicable";
  area: { key: AreaKey; label: string; matched: boolean } | null;
  assignee: string | null;
  path: HandlingPath;
  releaseDeveloper: boolean;
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

const awaitingApproval = (none: Ownership, notes: string[]): Ownership => {
  notes.push(
    `A feature request that nobody has approved gets no developer. It is labelled "${NEEDS_APPROVAL_LABEL}" for James to approve; add the "${APPROVED_LABEL}" label to release it.`
  );
  const parked = PARKABLE_PATHS.includes(none.path);
  return {
    ...none,
    approval: "needed",
    assignee: parked ? FALLBACK_OWNER : none.assignee,
    path: parked ? "Backlog/low-impact" : none.path,
    releaseDeveloper: parked ? false : none.releaseDeveloper,
  };
};

const bugAssignee = (
  area: AreaKey,
  path: HandlingPath,
  duplicate: boolean,
  closed: boolean
): string | null => {
  if (duplicate || path === "Engineering Todo") {
    return ownerForArea(area);
  }
  return path.startsWith("Support/") && !closed ? SUPPORT_OWNER : null;
};

export function resolveOwnership(context: {
  answers: Answers;
  bar: number;
  classification: TriageClassification;
  closed: boolean;
  duplicate: boolean;
  input: TriageInput;
  notes: string[];
  path: HandlingPath;
  project: string | null;
}): Ownership {
  const { answers, classification, duplicate, input, notes, path } = context;
  const followUp =
    classification !== "Bug" && !context.closed ? SUPPORT_OWNER : null;
  const none: Ownership = {
    approval: "not-applicable",
    area: null,
    assignee: followUp,
    path,
    releaseDeveloper: classification !== "Bug" && followUp === null,
  };
  if (input.identifier.toUpperCase().startsWith("SAN-")) {
    return { ...none, assignee: SUPPORT_OWNER, releaseDeveloper: false };
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
    const assignee = bugAssignee(area.key, path, duplicate, context.closed);
    if (assignee && !area.matched && assignee !== SUPPORT_OWNER) {
      notes.push(
        `The evidence does not place this in a mapped area, so it goes to ${FALLBACK_OWNER}; say which evidence is missing in the document.`
      );
    }
    return { ...none, area, assignee };
  }
  if (!isFeatureRequest(classification, answers)) {
    return none;
  }
  if (!hasLabel(input.ticketLabels ?? [], APPROVED_LABEL)) {
    return awaitingApproval(none, notes);
  }
  if (path !== "Platform Limitation" && path !== "Engineering Todo") {
    return { ...none, approval: "approved" };
  }
  const area = place();
  return {
    approval: "approved",
    area,
    assignee: ownerForArea(area.key),
    path: "Engineering Todo",
    releaseDeveloper: false,
  };
}

export const ownershipRoute = (
  ownership: Ownership,
  labels: string[]
): {
  addLabels: string[];
  assignee?: string;
  releaseDeveloper?: boolean;
  removeLabels?: string[];
} => ({
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
  ...(ownership.releaseDeveloper ? { releaseDeveloper: true } : {}),
});
