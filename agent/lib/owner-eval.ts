import {
  AREAS,
  type AreaKey,
  areaForProject,
  FALLBACK_AREA,
  isCrmArea,
  ownerForArea,
  specificAreaForFiles,
} from "./owner-map.js";

export interface EvalCase {
  areaSource: string;
  files: string[];
  project: string | null;
  ticket: string;
  trueArea: string;
}

export interface EvalMiss {
  predictedArea: AreaKey | null;
  predictedOwner: string | null;
  reason: "no project" | "wrong owner";
  ticket: string;
  trueArea: string;
}

export interface Tally {
  correct: number;
  total: number;
}

export interface EvalSummary {
  byArea: Record<string, Tally>;
  cases: number;
  correct: number;
  folderFromFiles: Tally;
  folderFromProject: Tally;
  misses: EvalMiss[];
  withProject: Tally;
}

const OWNERS_BY_FOLDER: Record<string, readonly string[]> = {
  "acquisity-agent": [AREAS.acquisity_agent.owner],
  "ai-sdr": [AREAS.ai_sdr.owner],
  "cold-email": [AREAS.cold_email.owner],
  "core-platform": [AREAS.core_platform.owner],
  crm: [AREAS.crm_records.owner, AREAS.crm_conversations.owner],
  other: [AREAS.other.owner],
  workflows: [AREAS.workflows.owner],
};

export const predictArea = (testCase: EvalCase): AreaKey | null => {
  if (!testCase.project) {
    return null;
  }
  const key = areaForProject(testCase.project) ?? FALLBACK_AREA;
  return isCrmArea(key) ? (specificAreaForFiles(testCase.files) ?? key) : key;
};

const tally = (target: Tally, right: boolean) => {
  target.total += 1;
  target.correct += right ? 1 : 0;
};

const isRight = (testCase: EvalCase, owner: string | null): boolean =>
  owner !== null && (OWNERS_BY_FOLDER[testCase.trueArea] ?? []).includes(owner);

export function evaluate(cases: readonly EvalCase[]): EvalSummary {
  const summary: EvalSummary = {
    byArea: {},
    cases: cases.length,
    correct: 0,
    folderFromFiles: { correct: 0, total: 0 },
    folderFromProject: { correct: 0, total: 0 },
    misses: [],
    withProject: { correct: 0, total: 0 },
  };
  for (const testCase of cases) {
    const predicted = predictArea(testCase);
    const owner = predicted ? ownerForArea(predicted) : null;
    const right = isRight(testCase, owner);
    summary.byArea[testCase.trueArea] ??= { correct: 0, total: 0 };
    tally(summary.byArea[testCase.trueArea] as Tally, right);
    summary.correct += right ? 1 : 0;
    if (testCase.project) {
      tally(summary.withProject, right);
    }
    tally(
      testCase.areaSource === "ticket-project"
        ? summary.folderFromProject
        : summary.folderFromFiles,
      right
    );
    if (!right) {
      summary.misses.push({
        predictedArea: predicted,
        predictedOwner: owner,
        reason: testCase.project ? "wrong owner" : "no project",
        ticket: testCase.ticket,
        trueArea: testCase.trueArea,
      });
    }
  }
  return summary;
}

const percent = (part: number, whole: number): string =>
  whole === 0 ? "n/a" : `${((100 * part) / whole).toFixed(1)}%`;

export function formatSummary(summary: EvalSummary): string {
  const lines = [
    `routing eval: ${summary.cases} past fixes from the fix memory, project then CRM path rules, no model`,
    `owner accuracy: ${summary.correct} of ${summary.cases} = ${percent(summary.correct, summary.cases)}`,
    `  cases with a project: ${summary.withProject.correct} of ${summary.withProject.total} = ${percent(summary.withProject.correct, summary.withProject.total)}`,
    `  fix folder chosen from the ticket's own project (agrees by construction unless the map splits the folder): ${summary.folderFromProject.correct} of ${summary.folderFromProject.total} = ${percent(summary.folderFromProject.correct, summary.folderFromProject.total)}`,
    `  fix folder chosen from the changed files or by default (all of these have no project): ${summary.folderFromFiles.correct} of ${summary.folderFromFiles.total} = ${percent(summary.folderFromFiles.correct, summary.folderFromFiles.total)}`,
    "by fix folder:",
    ...Object.entries(summary.byArea)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([folder, row]) =>
          `  ${folder}: ${row.correct} of ${row.total} = ${percent(row.correct, row.total)}`
      ),
    `misses (${summary.misses.length}):`,
    ...summary.misses.map(
      (miss) =>
        `  ${miss.ticket} folder=${miss.trueArea} predicted=${miss.predictedArea ?? "none"} owner=${miss.predictedOwner ?? "none"} (${miss.reason})`
    ),
  ];
  return lines.join("\n");
}
