import type { JevAnswer } from "./jev.js";
import type { TriageInput } from "./jev-decisions.js";

export const yes = (probability = 0.9): JevAnswer => ({
  probability,
  type: "boolean",
});
export const no = (): JevAnswer => ({ probability: 0.1, type: "boolean" });
export const pick = (choice: string, confidence = 0.9): JevAnswer => ({
  choice,
  probabilities: { [choice]: confidence },
  type: "choice",
});
export const band = (probabilities: Record<string, number>): JevAnswer => ({
  probabilities,
  score: 0,
  type: "score",
});

export const triageInput = (over: Partial<TriageInput> = {}): TriageInput => ({
  blastRadius: {
    countedAt: "2026-09-25",
    orgs: 3,
    query: "select count(*)",
    users: 4,
  },
  claim: "Replies stopped arriving.",
  codePath: {
    commit: "a".repeat(40),
    file: "webhook.ts",
    function: "handleReply",
  },
  duplicateCandidates: [],
  evidence: "Inngest run failed at step parse.",
  identifier: "ENG-1",
  projects: [{ name: "AI SDR Core" }],
  rootCauseLabels: [],
  sourceLabels: ["Customer reported"],
  ...over,
});

export const bugAnswers = (
  over: Record<string, JevAnswer> = {}
): Record<string, JevAnswer> => ({
  classification: pick("bug"),
  customer_saw_failure: no(),
  data_loss_or_security: no(),
  direct_evidence: yes(),
  impact: band({ "0": 0.05, "1": 0.8, "2": 0.1, "3": 0.05 }),
  inbox_error: no(),
  incident: pick("standard"),
  incident_impact: pick("MATERIALLY_IMPAIRED"),
  money_blocker: no(),
  path: pick("Engineering Todo"),
  project: pick("AI SDR Core"),
  verdict: pick("supported"),
  wants_limit_lifted: no(),
  ...over,
});
