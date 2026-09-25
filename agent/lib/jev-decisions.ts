import {
  askJev,
  choiceOf,
  type JevAnswer,
  type JevOptions,
  type JevQuestion,
  probabilityOf,
} from "./jev.js";

/**
 * Every triage and billing decision Foreman used to make in prose, as Jev
 * questions plus the code that turns the answers into routing.
 *
 * @remarks
 * Jev judges; this file decides what a judgment is allowed to do. Each
 * decision asks all of its questions in one call, including ones that only
 * matter on some branches, and the resolvers below branch in code. Counts,
 * dates, and whether evidence exists are checked here, never asked of Jev.
 * The bars scale with what an answer changes: a label is cheap to get wrong,
 * closing a ticket as a duplicate is not.
 */
export const BARS = {
  /** Below this, money versus product is unclear and the requester is asked. */
  askKind: 0.7,
  /** A billing verdict below this is left to a person. */
  discretion: 0.7,
  /** A duplicate closes the ticket, so it needs a near-certain match. */
  duplicate: 0.8,
  /** Below this, the priority band takes the higher neighbour. */
  priorityBand: 0.6,
  /** Below this, the project is left unset and Aaron routes it. */
  project: 0.6,
  /** A root cause label is only added when the match is clear. */
  rootCauseLabel: 0.6,
  /** Yes/no signals that only add a label or raise a floor. */
  signal: 0.5,
  /** Below this, the claim is treated as unproven. */
  verdict: 0.6,
} as const;

const UNDETERMINED = "undetermined";
const NO_LABEL = "none";

const PRIORITY = { high: 2, low: 4, medium: 3, urgent: 1 } as const;
type Band = keyof typeof PRIORITY;
const BANDS_HIGH_TO_LOW: Band[] = ["urgent", "high", "medium", "low"];

const sourceQuestions: Record<string, JevQuestion> = {
  source_customer: {
    instructions: "Did a customer raise this report?",
    type: "boolean",
  },
  source_intercom: {
    instructions: "Did this report come from an Intercom conversation?",
    type: "boolean",
  },
  source_internal: {
    instructions:
      "Did an internal person (AIA CS or another Acquisity employee) report this?",
    type: "boolean",
  },
};

const sourceLabels = (answers: Record<string, JevAnswer>): string[] =>
  [
    ["source_intercom", "intercom-sourced"],
    ["source_customer", "Customer reported"],
    ["source_internal", "Internal reported"],
  ]
    .filter(([key]) => probabilityOf(answers[key]) >= BARS.signal)
    .map(([, label]) => label);

// ---------------------------------------------------------------- ask kind

export const BILLING_BUCKETS = {
  coupon_code: "a discount or coupon code that failed or was not applied",
  credits:
    "the in-app product credit balance (lead or website credits) is wrong or needs topping up",
  overcharged: "charged more than expected, or charged for something cancelled",
  refund: "wants money that was charged returned",
  stripe_credit:
    "wants money applied against future invoices of a subscription they are keeping, rather than returned",
} as const;
export type BillingBucket = keyof typeof BILLING_BUCKETS;

const BUCKET_LABELS: Record<BillingBucket, string> = {
  coupon_code: "Discount",
  credits: "Credits",
  overcharged: "Refund",
  refund: "Refund",
  stripe_credit: "Credits",
};

export interface AskKindDecision {
  bucket: BillingBucket | null;
  confidence: number;
  kind: "money" | "product" | "unclear";
  sourceLabels: string[];
}

/**
 * Money or product, and the billing bucket and source labels in the same
 * call, since both are needed on the branch that follows and cost nothing
 * extra to ask.
 */
export async function decideAskKind(
  report: string,
  opts?: JevOptions
): Promise<AskKindDecision> {
  const answers = await askJev(
    {
      bucket: {
        criteria: { ...BILLING_BUCKETS },
        instructions:
          "If this is a money ask, which single outcome does the requester predominantly want?",
        type: "choice",
      },
      kind: {
        criteria: {
          money:
            "refunds, charges, credits, coupons, subscriptions, invoices, or plans: the requester wants money or a balance changed",
          product:
            "the product is broken, confusing, or missing something; no money or balance change is asked for",
        },
        instructions: "What is the predominant ask of this report?",
        type: "choice",
      },
      ...sourceQuestions,
    },
    { report },
    opts
  );
  const kind = choiceOf(answers.kind);
  const settled = kind.confidence >= BARS.askKind;
  const isMoney = settled && kind.choice === "money";
  return {
    bucket: isMoney ? (choiceOf(answers.bucket).choice as BillingBucket) : null,
    confidence: kind.confidence,
    kind: settled ? (kind.choice as "money" | "product") : "unclear",
    sourceLabels: sourceLabels(answers),
  };
}

// ---------------------------------------------------------------- triage

export const HANDLING_PATHS = {
  "Backlog/low-impact":
    "a real but low-impact issue nobody needs to act on now",
  "Engineering Todo": "a root cause engineering must fix",
  "Platform Limitation":
    "expected behaviour, a provider limit, or a plan or entitlement limit",
  "Resolved by triage": "already fixed or resolved during this investigation",
  "Support/Financial": "a person must act on money for this customer",
  "Support/Product follow-up":
    "a person must follow up with the customer about the product",
  "User Error":
    "settings, configuration, or something the customer or support can fix",
} as const;
export type HandlingPath = keyof typeof HANDLING_PATHS | "Duplicate";

const PATH_STATE: Record<HandlingPath, string> = {
  "Backlog/low-impact": "Backlog",
  Duplicate: "Duplicate",
  "Engineering Todo": "Todo",
  "Platform Limitation": "Done",
  "Resolved by triage": "Done",
  "Support/Financial": "Todo",
  "Support/Product follow-up": "Todo",
  "User Error": "Done",
};

/** Paths whose band is Low unless data loss or money raises it. */
const LOW_PATHS = new Set<HandlingPath>([
  "Backlog/low-impact",
  "Platform Limitation",
  "Resolved by triage",
]);

export interface TriageInput {
  blastRadius?: {
    countedAt: string;
    orgs: number;
    query: string;
    users: number;
  };
  claim: string;
  codePath?: { commit: string; file: string; function: string };
  duplicateCandidates: {
    identifier: string;
    priority?: number;
    summary: string;
    title: string;
  }[];
  evidence: string;
  identifier: string;
  projects: { description?: string; name: string }[];
  rootCauseLabels: string[];
  sourceLabels: string[];
}

export interface TriageRoute {
  addLabels: string[];
  assignee?: string;
  duplicateOf?: string;
  inheritAssigneeFrom?: string;
  priority: number;
  project?: string;
  state: string;
}

export type TriageDecision =
  | {
      missing: string[];
      notes: string[];
      outcome: "unproven";
      verdict: { confidence: number; value: string };
    }
  | {
      assignee: "Aaron Fraga" | "area owner";
      classification: TriageClassification;
      needsCriticReview: boolean;
      notes: string[];
      outcome: "route";
      path: HandlingPath;
      route: TriageRoute;
      verdict: { confidence: number; value: string };
    };

const CLASSIFICATIONS = {
  bug: "an internal failure that settings, configuration, and platform limits do not explain",
  platform_limitation:
    "expected behaviour, or a provider, billing, entitlement, or plan limit",
  user_error:
    "settings, configuration, or something support can explain or follow up on",
} as const;

const CLASSIFICATION_NAMES = {
  bug: "Bug",
  platform_limitation: "Platform Limitation",
  user_error: "User Error",
} as const;
type TriageClassification =
  (typeof CLASSIFICATION_NAMES)[keyof typeof CLASSIFICATION_NAMES];

const DUPLICATE_OUTCOMES = {
  not_relevant: "unrelated beyond shared words or components",
  partial_or_adjacent: "related, but a different symptom or cause",
  same_outcome: "the same symptom with the same cause",
  stale_or_superseded: "the same area, but already fixed or decided",
} as const;

export function triageQuestions(
  input: TriageInput
): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {
    classification: {
      criteria: { ...CLASSIFICATIONS },
      instructions:
        "Given the evidence, which one classification fits the root cause? Rule out settings, configuration, permissions, billing, provider limits, and expected behaviour before calling it a bug.",
      type: "choice",
    },
    data_loss_or_security: {
      instructions:
        "Does the evidence show data corruption, data loss, or a security exposure?",
      type: "boolean",
    },
    direct_evidence: {
      instructions:
        "Does the evidence include direct current production-data, runtime, or provider evidence of an internal failure (logs, failed jobs, schema mismatch, provider or API error), not only a suspicion?",
      type: "boolean",
    },
    impact: {
      criteria: [
        "low: cosmetic, edge case, platform limitation, resolved, or backlog",
        "medium: a real defect with single-organization impact, or non-blocking money follow-up",
        "high: a confirmed multi-organization failure, a money issue requiring action, or a repeat production failure",
        "urgent: an outage, major revenue or trust incident, or a core workflow unavailable for a large share of active organizations",
      ],
      instructions:
        "How severe is the impact, weighing blast radius, then frequency, then customer tier? A workaround does not reduce it.",
      type: "score",
    },
    money_blocker: {
      instructions:
        "Is there an active billing or refund blocker for the customer?",
      type: "boolean",
    },
    path: {
      criteria: { ...HANDLING_PATHS },
      instructions:
        "Which handling path fits the root cause? The path classifies the cause, not the remedy.",
      type: "choice",
    },
    project: {
      criteria: {
        ...Object.fromEntries(
          input.projects.map((project) => [
            project.name,
            project.description ?? project.name,
          ])
        ),
        [UNDETERMINED]:
          "the evidence does not establish which product area owns the root cause",
      },
      instructions:
        "Which product project owns the confirmed root cause and its code path? Judge from the evidence, never from the ticket title or its incoming project.",
      type: "choice",
    },
    verdict: {
      criteria: {
        contradicted: "the evidence contradicts the claim",
        supported: "the evidence supports the claim",
        unproven: "a deciding confirmation is still missing",
      },
      instructions:
        "Does the evidence support the claim, contradict it, or leave it unproven?",
      type: "choice",
    },
    wants_limit_lifted: {
      instructions:
        "Does the customer want a platform limit lifted or a missing capability added?",
      type: "boolean",
    },
  };
  if (input.rootCauseLabels.length > 0) {
    questions.root_cause_label = {
      criteria: {
        ...Object.fromEntries(input.rootCauseLabels.map((l) => [l, l])),
        [NO_LABEL]: "no label matches the cause found",
      },
      instructions: "Which root cause label matches the cause found?",
      type: "choice",
    };
  }
  input.duplicateCandidates.forEach((_candidate, index) => {
    questions[`duplicate_${index}`] = {
      criteria: { ...DUPLICATE_OUTCOMES },
      instructions: `Compare this report with the duplicate candidate whose candidate field is ${index}. Judge by outcome, not keyword overlap: a shared component or error string is not enough.`,
      type: "choice",
    };
  });
  return questions;
}

const bandOf = (
  answer: JevAnswer | undefined
): { band: Band; note?: string } => {
  if (answer?.type !== "score") {
    throw new Error("Expected a score answer.");
  }
  // Score rungs run low (0) to urgent (3).
  const rungs: Band[] = ["low", "medium", "high", "urgent"];
  const ranked = Object.entries(answer.probabilities)
    .map(([rung, p]) => ({ band: rungs[Number(rung)], p }))
    .filter((r): r is { band: Band; p: number } => r.band !== undefined)
    .sort((a, b) => b.p - a.p);
  const [top, next] = ranked;
  if (!top) {
    throw new Error("Jev returned no priority band.");
  }
  const higher = BANDS_HIGH_TO_LOW[BANDS_HIGH_TO_LOW.indexOf(top.band) - 1];
  if (top.p < BARS.priorityBand && next && next.band === higher) {
    return {
      band: higher,
      note: `Priority sat between ${higher} and ${top.band}; took ${higher}. Flag for a domain expert.`,
    };
  }
  return { band: top.band };
};

type Answers = Record<string, JevAnswer>;

const findDuplicate = (input: TriageInput, answers: Answers) =>
  input.duplicateCandidates
    .map((candidate, index) => ({
      candidate,
      ...choiceOf(answers[`duplicate_${index}`]),
    }))
    .filter(
      (d) => d.choice === "same_outcome" && d.confidence >= BARS.duplicate
    )
    .sort((a, b) => b.confidence - a.confidence)
    .at(0);

/** What a Bug verdict still lacks: all three are required, and two are checked in code. */
const bugBarGaps = (input: TriageInput, answers: Answers): string[] =>
  [
    input.codePath ? null : "A named file and function the cause runs through.",
    probabilityOf(answers.direct_evidence) >= BARS.signal
      ? null
      : "Direct production-data or runtime/provider evidence of the failure.",
    input.blastRadius ? null : "A blast radius counted by a query.",
  ].filter((gap): gap is string => gap !== null);

const resolvePriority = (
  path: HandlingPath,
  inherited: number | undefined,
  answers: Answers,
  notes: string[]
): number => {
  let priority: number;
  if (inherited) {
    priority = inherited;
  } else if (probabilityOf(answers.data_loss_or_security) >= BARS.signal) {
    priority = PRIORITY.urgent;
  } else if (LOW_PATHS.has(path)) {
    priority = PRIORITY.low;
  } else {
    const { band, note } = bandOf(answers.impact);
    priority = PRIORITY[band];
    if (note) {
      notes.push(note);
    }
  }
  return probabilityOf(answers.money_blocker) >= BARS.signal
    ? Math.min(priority, PRIORITY.high)
    : priority;
};

const resolveLabels = (
  input: TriageInput,
  classification: TriageClassification,
  answers: Answers
): string[] => {
  const labels = [...input.sourceLabels];
  if (classification === "Bug") {
    labels.push("Bug");
  } else if (
    classification === "Platform Limitation" &&
    probabilityOf(answers.wants_limit_lifted) >= BARS.signal
  ) {
    labels.push("Feature Request");
  }
  if (answers.root_cause_label) {
    const { choice, confidence } = choiceOf(answers.root_cause_label);
    if (choice !== NO_LABEL && confidence >= BARS.rootCauseLabel) {
      labels.push(choice);
    }
  }
  return [...new Set(labels)];
};

/** Turns Jev's answers into the triage decision. Pure, so it is tested alone. */
export function resolveTriage(
  input: TriageInput,
  answers: Answers
): TriageDecision {
  const notes: string[] = [];
  const { choice, confidence } = choiceOf(answers.verdict);
  const verdict = { confidence, value: choice };
  if (verdict.value === "unproven" || verdict.confidence < BARS.verdict) {
    return {
      missing: ["A deciding confirmation for the claim."],
      notes,
      outcome: "unproven",
      verdict,
    };
  }

  const duplicate = findDuplicate(input, answers);
  const classification =
    CLASSIFICATION_NAMES[
      choiceOf(answers.classification)
        .choice as keyof typeof CLASSIFICATION_NAMES
    ];
  if (classification === "Bug" && !duplicate) {
    const missing = bugBarGaps(input, answers);
    if (missing.length > 0) {
      notes.push("Not a Bug yet: the Bug bar is not met.");
      return { missing, notes, outcome: "unproven", verdict };
    }
  }

  const path: HandlingPath = duplicate
    ? "Duplicate"
    : (choiceOf(answers.path).choice as HandlingPath);
  const priority = resolvePriority(
    path,
    duplicate?.candidate.priority,
    answers,
    notes
  );

  const project = choiceOf(answers.project);
  const projectSettled =
    project.choice !== UNDETERMINED && project.confidence >= BARS.project;
  if (!projectSettled) {
    notes.push(
      "The evidence does not settle the owning project; say which evidence is missing in the document."
    );
  }
  const aaron =
    !projectSettled || input.identifier.toUpperCase().startsWith("SAN-");

  return {
    assignee: aaron ? "Aaron Fraga" : "area owner",
    classification,
    needsCriticReview: classification === "Bug" && path !== "Duplicate",
    notes,
    outcome: "route",
    path,
    route: {
      addLabels: resolveLabels(input, classification, answers),
      priority,
      state: PATH_STATE[path],
      ...(projectSettled ? { project: project.choice } : {}),
      ...(aaron ? { assignee: "Aaron Fraga" } : {}),
      ...(duplicate
        ? {
            duplicateOf: duplicate.candidate.identifier,
            inheritAssigneeFrom: duplicate.candidate.identifier,
          }
        : {}),
    },
    verdict,
  };
}

export async function decideTriage(
  input: TriageInput,
  opts?: JevOptions
): Promise<TriageDecision> {
  const state = {
    blastRadius: input.blastRadius ?? null,
    claim: input.claim,
    codePath: input.codePath ?? null,
    duplicateCandidates: input.duplicateCandidates.map(
      ({ identifier, summary, title }, candidate) => ({
        candidate,
        identifier,
        summary,
        title,
      })
    ),
    evidence: input.evidence,
  };
  const answers = await askJev(triageQuestions(input), state, opts);
  return resolveTriage(input, answers);
}

// ---------------------------------------------------------------- billing

export const BILLING_CHECKLIST = {
  amount_from_primary_data:
    "The amount in dispute is quantified from primary data, not the reporter's claim.",
  approval_quoted:
    "Any prior approval or promise is quoted verbatim from the trail, or its absence is stated.",
  charge_matches_record:
    "The charge matches a real invoice or subscription in the system of record.",
  credit_history_read:
    "The credit balance and prior-credit history are read from the production database.",
  plan_state_matches:
    "The plan and add-on state in Autumn matches what the requester believes and matches PlanetScale.",
  requester_account_weighed:
    "The requester's own account has been weighed against the systems of record, and any contradiction is named.",
  single_bucket: "The predominant ask is a single taxonomy bucket.",
} as const;

export interface BillingInput {
  approvalQuote: string | null;
  bucket: BillingBucket;
  evidence: string;
  sourceLabels: string[];
}

export interface BillingDecision {
  discretion: "justified" | "needs-human" | "not justified";
  notes: string[];
  route: {
    addLabels: string[];
    assignee: "Aaron Fraga";
    priority: number;
    project: "Support";
    state: "Todo";
  };
  unconfirmed: string[];
}

export function billingQuestions(): Record<string, JevQuestion> {
  return {
    active_blocker: {
      instructions:
        "Is this an active billing or refund blocker for the customer right now?",
      type: "boolean",
    },
    discretion: {
      criteria: {
        justified: "the evidence supports the refund or credit",
        needs_human:
          "the deciding fact is only available to a person and has not landed",
        not_justified: "the evidence does not support it",
      },
      instructions:
        "Weighing the systems of record against the requester's account, is the refund or credit justified?",
      type: "choice",
    },
    ...Object.fromEntries(
      Object.entries(BILLING_CHECKLIST).map(([key, text]) => [
        `check_${key}`,
        {
          instructions: `Does the evidence confirm this? ${text}`,
          type: "boolean",
        } satisfies JevQuestion,
      ])
    ),
  };
}

const DISCRETION: Record<string, BillingDecision["discretion"]> = {
  justified: "justified",
  needs_human: "needs-human",
  not_justified: "not justified",
};

export function resolveBilling(
  input: BillingInput,
  answers: Record<string, JevAnswer>
): BillingDecision {
  const notes: string[] = [];
  const unconfirmed = Object.entries(BILLING_CHECKLIST)
    .filter(([key]) => probabilityOf(answers[`check_${key}`]) < BARS.signal)
    .map(([, text]) => text);
  const pick = choiceOf(answers.discretion);
  let discretion = DISCRETION[pick.choice] ?? "needs-human";
  if (discretion !== "needs-human" && pick.confidence < BARS.discretion) {
    discretion = "needs-human";
    notes.push("The verdict was not clear enough to settle without a person.");
  }
  if (discretion === "justified" && unconfirmed.length > 0) {
    discretion = "needs-human";
    notes.push("Justified needs every checklist item confirmed.");
  }
  if (!input.approvalQuote?.trim()) {
    discretion = "needs-human";
    notes.push("No prior approval or promise was found in the trail.");
  }
  return {
    discretion,
    notes,
    route: {
      addLabels: [
        ...new Set([BUCKET_LABELS[input.bucket], ...input.sourceLabels]),
      ],
      assignee: "Aaron Fraga",
      priority:
        probabilityOf(answers.active_blocker) >= BARS.signal
          ? PRIORITY.high
          : PRIORITY.medium,
      project: "Support",
      state: "Todo",
    },
    unconfirmed,
  };
}

export async function decideBilling(
  input: BillingInput,
  opts?: JevOptions
): Promise<BillingDecision> {
  const state = {
    approvalQuote: input.approvalQuote,
    bucket: input.bucket,
    evidence: input.evidence,
  };
  const answers = await askJev(billingQuestions(), state, opts);
  return resolveBilling(input, answers);
}
