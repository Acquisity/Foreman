import {
  AREA_KEYS,
  type AreaKey,
  areaForPath,
  areaForProject,
  FALLBACK_AREA,
  isCrmArea,
  ownerForArea,
  specificAreaForFiles,
} from "./owner-map.js";

export interface EvalCase {
  files: string[];
  project: string | null;
  ticket: string;
  ticketPaths: string[];
}

export interface Tally {
  correct: number;
  total: number;
}

export interface EvalMiss {
  predictedArea: AreaKey | null;
  predictedOwner: string | null;
  reason: "no project and no path" | "wrong owner";
  ticket: string;
  trueArea: AreaKey;
}

export interface EvalSummary {
  ambiguous: number;
  byCrmArea: Partial<Record<AreaKey, Tally>>;
  cases: number;
  misses: EvalMiss[];
  overall: Tally;
  withoutProject: Tally;
  withProject: Tally;
}

const FILE_RULES: readonly (readonly [AreaKey, readonly string[]])[] = [
  ["ai_sdr", ["ai-sdr"]],
  ["workflows", ["lib/workflows", "components/workflows", "routers/workflows"]],
  [
    "billing",
    [
      "components/billing",
      "lib/billing",
      "routers/billing",
      "app/api/autumn",
      "webhooks/whop",
    ],
  ],
  [
    "inboxes_domains",
    ["domain-marketplace", "lib/domains", "components/domain", "mailbox"],
  ],
  [
    "cold_email",
    [
      "campaigns",
      "outreach",
      "lead-sources",
      "instantly",
      "smartlead",
      "lib/leads",
      "cold-email",
    ],
  ],
  [
    "acquisity_agent",
    [
      "components/ai-chat",
      "lib/chat/",
      "lib/ai-consultant",
      "app/api/chat",
      "app/api/completion",
      "components/ai-elements",
    ],
  ],
  [
    "core_platform",
    [
      "lib/auth",
      "components/auth",
      "components/organization",
      "lib/organization",
      "lib/permissions",
      "components/invitations",
    ],
  ],
  ["devops", [".github/", "apps/web/scripts/"]],
];

const areaOfFile = (file: string): AreaKey | null => {
  const crm = areaForPath(file);
  if (crm) {
    return crm;
  }
  const path = file.replaceAll("\\", "/");
  return (
    FILE_RULES.find(([, parts]) =>
      parts.some((part) => path.includes(part))
    )?.[0] ?? null
  );
};

export const truthArea = (files: readonly string[]): AreaKey | null => {
  const votes = new Map<AreaKey, number>();
  for (const file of files) {
    const area = areaOfFile(file);
    if (area) {
      votes.set(area, (votes.get(area) ?? 0) + 1);
    }
  }
  const ranked = [...votes.entries()].sort(([, a], [, b]) => b - a);
  const [top, next] = ranked;
  return top && top[1] !== next?.[1] ? top[0] : null;
};

export const predictArea = (testCase: EvalCase): AreaKey | null => {
  if (testCase.project) {
    const key = areaForProject(testCase.project) ?? FALLBACK_AREA;
    return isCrmArea(key)
      ? (specificAreaForFiles(testCase.ticketPaths) ?? key)
      : key;
  }
  for (const file of testCase.ticketPaths) {
    const key = areaForPath(file);
    if (key) {
      return key;
    }
  }
  return null;
};

const tally = (target: Tally, right: boolean) => {
  target.total += 1;
  target.correct += right ? 1 : 0;
};

const emptyTally = (): Tally => ({ correct: 0, total: 0 });

export function evaluate(cases: readonly EvalCase[]): EvalSummary {
  const summary: EvalSummary = {
    ambiguous: 0,
    byCrmArea: {},
    cases: cases.length,
    misses: [],
    overall: emptyTally(),
    withoutProject: emptyTally(),
    withProject: emptyTally(),
  };
  for (const testCase of cases) {
    const truth = truthArea(testCase.files);
    if (!truth) {
      summary.ambiguous += 1;
      continue;
    }
    const predicted = predictArea(testCase);
    const owner = predicted ? ownerForArea(predicted) : null;
    const right = owner === ownerForArea(truth);
    tally(summary.overall, right);
    tally(
      testCase.project ? summary.withProject : summary.withoutProject,
      right
    );
    if (isCrmArea(truth)) {
      summary.byCrmArea[truth] ??= emptyTally();
      tally(summary.byCrmArea[truth] as Tally, right);
    }
    if (!right) {
      summary.misses.push({
        predictedArea: predicted,
        predictedOwner: owner,
        reason: predicted ? "wrong owner" : "no project and no path",
        ticket: testCase.ticket,
        trueArea: truth,
      });
    }
  }
  return summary;
}

const percent = (tallyValue: Tally): string =>
  tallyValue.total === 0
    ? "n/a"
    : `${tallyValue.correct} of ${tallyValue.total} = ${((100 * tallyValue.correct) / tallyValue.total).toFixed(1)}%`;

export function formatSummary(summary: EvalSummary): string {
  return [
    `routing eval: ${summary.cases} past fixes from the fix memory, no model`,
    "truth: the area the fix landed in, voted by its changed files (CRM sub-area by the CRM path rules); never the ticket's project",
    "prediction: the ticket's project, then the CRM path rules over paths the ticket text names",
    `not scorable (no area-specific changed file, or a tied vote): ${summary.ambiguous}`,
    `owner accuracy: ${percent(summary.overall)}`,
    `  with a project: ${percent(summary.withProject)}`,
    `  without a project: ${percent(summary.withoutProject)}`,
    "by CRM sub-area (the single owner the map gives it):",
    ...AREA_KEYS.filter(isCrmArea).map(
      (key) => `  ${key}: ${percent(summary.byCrmArea[key] ?? emptyTally())}`
    ),
    `misses (${summary.misses.length}):`,
    ...summary.misses.map(
      (miss) =>
        `  ${miss.ticket} truth=${miss.trueArea} predicted=${miss.predictedArea ?? "none"} owner=${miss.predictedOwner ?? "none"} (${miss.reason})`
    ),
  ].join("\n");
}
