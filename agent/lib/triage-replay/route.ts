import { createHash, timingSafeEqual } from "node:crypto";
import type { SessionAuthContext } from "eve/context";
import { z } from "zod";
import {
  readPrivateDocument,
  TRIAGE_REPLAY_PREFIX,
  writePrivateDocument,
} from "../blob.js";
import { stampTriageIntake, stampUnattended } from "../trust.js";
import {
  loadReplayState,
  replayBackend,
  replayKeyDigest,
  replayStateKey,
  seedReplayStore,
} from "./backend.js";
import { UNSEEDED_IMAGE } from "./hook.js";
import {
  isTriageReplay,
  TRIAGE_REPLAY_CASE_ATTRIBUTE,
  TRIAGE_REPLAY_RUN_ATTRIBUTE,
} from "./mode.js";
import { type TriageResult, triageCaseSchema } from "./schema.js";
import {
  appliedRoute,
  frozenListsSchema,
  type ReplayState,
  seedReplayState,
} from "./store.js";

/**
 * The replay's two routes (ENG-16049). Every guard is on the server: the
 * process must be a replay process, the caller must hold the diagnostics
 * secret, the server must carry TRIAGE_REPLAY_CONFIRM=1 and the approved run
 * id, and the run's Blob ledger refuses starts past TRIAGE_REPLAY_MAX_RUNS
 * or past TRIAGE_REPLAY_MAX_USD of estimated model spend, across restarts
 * and processes.
 */
export const REPLAY_SECRET_HEADER = "x-foreman-diagnostics-secret";

const ARCHIVE_HOST = /\.blob\.vercel-storage\.com$/u;

export const startRequestSchema = z.strictObject({
  archiveUrl: z.url().refine(
    (value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        ARCHIVE_HOST.test(url.host) &&
        url.pathname.startsWith(`/${TRIAGE_REPLAY_PREFIX}archives/`)
      );
    },
    { message: "The archive must be a replay archive in Foreman's Blob store." }
  ),
  case: triageCaseSchema,
  cohortSha256: z.string().regex(/^[0-9a-f]{64}$/),
  lists: frozenListsSchema,
  run: z.int().positive(),
  runId: z.string().regex(/^[A-Za-z0-9_-]{6,80}$/),
});
export type StartRequest = z.infer<typeof startRequestSchema>;

const digest = (value: string) => createHash("sha256").update(value).digest();

const json = (body: unknown, status = 200) =>
  Response.json(body, { headers: { "cache-control": "no-store" }, status });

/** Refuses unless this is a confirmed replay process and the caller holds the secret. */
export function replayRefusal(
  request: Request,
  env: NodeJS.ProcessEnv = process.env
): Response | null {
  if (!isTriageReplay(env)) {
    return json({ error: "Not found." }, 404);
  }
  const expected = env.FOREMAN_DIAGNOSTICS_SECRET;
  if (!expected || expected.length < 32) {
    return json({ error: "Replay is not configured." }, 503);
  }
  const given = request.headers.get(REPLAY_SECRET_HEADER) ?? "";
  if (!timingSafeEqual(digest(given), digest(expected))) {
    return json({ error: "Forbidden." }, 403);
  }
  if (env.TRIAGE_REPLAY_CONFIRM !== "1") {
    return json(
      { error: "TRIAGE_REPLAY_CONFIRM=1 is not set on the server." },
      403
    );
  }
  return null;
}

/** The admission ledger: the starts this approved run has used and the model spend charged for them, with the version read. */
export interface LedgerEntries {
  admitted: string[];
  chargedUsd: number;
}

export interface AdmissionLedger {
  read: (runId: string) => Promise<LedgerEntries & { etag: string | null }>;
  write: (
    runId: string,
    entries: LedgerEntries,
    etag: string | null
  ) => Promise<"conflict" | "written">;
}

const ledgerKey = (runId: string) =>
  `${TRIAGE_REPLAY_PREFIX}${replayKeyDigest([runId, "ledger"])}/ledger.json`;

const ledgerSchema = z.strictObject({
  admitted: z.array(z.string()),
  chargedUsd: z.number().nonnegative(),
});

export const blobLedger: AdmissionLedger = {
  async read(runId) {
    const result = await readPrivateDocument(ledgerKey(runId));
    return result.found
      ? { ...ledgerSchema.parse(JSON.parse(result.content)), etag: result.etag }
      : { admitted: [], chargedUsd: 0, etag: null };
  },
  write: (runId, entries, etag) =>
    writePrivateDocument(ledgerKey(runId), JSON.stringify(entries), {
      contentType: "application/json",
      ifMatch: etag,
    }),
};

const ADMISSION_ATTEMPTS = 8;

interface Allowance {
  costPerCase: number;
  maxRuns: number;
  maxUsd: number;
}

const usd = (value: number) => `$${value.toFixed(2)}`;

async function claim(
  entry: string,
  runId: string,
  allowance: Allowance,
  ledger: AdmissionLedger,
  attempt = 0
): Promise<string | null> {
  if (attempt >= ADMISSION_ATTEMPTS) {
    return "The admission ledger kept changing, so this start is refused.";
  }
  const { admitted, chargedUsd, etag } = await ledger.read(runId);
  if (admitted.includes(entry)) {
    return `${entry} was already started in this run.`;
  }
  if (admitted.length >= allowance.maxRuns) {
    return `This run has used its ${allowance.maxRuns} admitted replays.`;
  }
  if (chargedUsd + allowance.costPerCase > allowance.maxUsd) {
    return `This run has charged an estimated ${usd(chargedUsd)} of its ${usd(allowance.maxUsd)} model spend cap, and another case would add ${usd(allowance.costPerCase)}.`;
  }
  const written = await ledger.write(
    runId,
    {
      admitted: [...admitted, entry],
      chargedUsd: chargedUsd + allowance.costPerCase,
    },
    etag
  );
  return written === "written"
    ? null
    : claim(entry, runId, allowance, ledger, attempt + 1);
}

const positive = (value: string | undefined) => {
  const parsed = Number(value);
  return value && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/** Admits one start for the approved run, or says why not; a lost race rereads the ledger. */
export function admit(
  request: StartRequest,
  ledger: AdmissionLedger,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  if (!env.TRIAGE_REPLAY_RUN_ID || request.runId !== env.TRIAGE_REPLAY_RUN_ID) {
    return Promise.resolve(
      "This run id is not the one approved on the server."
    );
  }
  const maxUsd = positive(env.TRIAGE_REPLAY_MAX_USD);
  const costPerCase = positive(env.TRIAGE_REPLAY_EST_USD_PER_CASE);
  if (maxUsd === null || costPerCase === null) {
    return Promise.resolve(
      "TRIAGE_REPLAY_MAX_USD and TRIAGE_REPLAY_EST_USD_PER_CASE must both be set on the server."
    );
  }
  return claim(
    `${request.case.id}#${request.run}`,
    request.runId,
    { costPerCase, maxRuns: Number(env.TRIAGE_REPLAY_MAX_RUNS ?? 3), maxUsd },
    ledger
  );
}

/** The signed identity a replay session and its subagents carry. */
export function replayAuth(runId: string, caseId: string): SessionAuthContext {
  return stampUnattended(
    stampTriageIntake({
      attributes: {
        [TRIAGE_REPLAY_CASE_ATTRIBUTE]: caseId,
        [TRIAGE_REPLAY_RUN_ATTRIBUTE]: runId,
      },
      authenticator: "bearer",
      issuer: "foreman-triage-replay",
      principalId: `triage-replay:${runId}`,
      principalType: "service",
    })
  );
}

/** The message a replay session starts from: the ticket as it was first filed. */
export function replayMessage(request: StartRequest): string {
  const { ticket } = request.case;
  const attachments =
    ticket.attachmentKinds.length > 0
      ? `\n\nAttachments: ${ticket.attachmentKinds.join(", ")}.`
      : "";
  return `Triage ${request.case.id}, delegated to you in Linear.\n\n${request.case.id}: ${ticket.title}\n\n${ticket.description}${attachments}`;
}

/** One replay of one case: the store key and the session's case attribute. */
export const caseKeyOf = (request: { case: { id: string }; run: number }) =>
  `${request.case.id}#${request.run}`;

/** Seeds the case's store; a second start of the same case and run is refused by the ledger first. */
export async function seedStore(request: StartRequest) {
  await seedReplayStore(
    replayStateKey(request.runId, caseKeyOf(request)),
    seedReplayState(
      request.case,
      request.lists,
      request.archiveUrl,
      request.cohortSha256
    )
  );
}

/** Reads one replay's store and builds its result; `settled` is false while it still works. */
export async function readReplayResult(params: {
  caseKey: string;
  cohortSha256: string;
  runId: string;
}): Promise<{ result: TriageResult; settled: boolean } | null> {
  const key = replayStateKey(params.runId, params.caseKey);
  const stored = await replayBackend().read(key);
  if (!stored) {
    return null;
  }
  const state = replaySettled(stored.state)
    ? ((await loadReplayState(key)) ?? stored.state)
    : stored.state;
  const run = Number(params.caseKey.split("#")[1] ?? 1);
  const result = buildReplayResult(state, {
    cohortSha256: state.cohortSha256,
    run,
    runId: params.runId,
  });
  return { result, settled: replaySettled(state) };
}

export async function startReplay(
  request: Request,
  args: {
    from: (address: string) => {
      send: (
        message: string,
        options: { auth: SessionAuthContext }
      ) => Promise<{ id: string }>;
    };
  },
  ledger: AdmissionLedger = blobLedger
): Promise<Response> {
  const refusal = replayRefusal(request);
  if (refusal) {
    return refusal;
  }
  const parsed = startRequestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    return json({ error: "Invalid replay start request." }, 400);
  }
  const start = parsed.data;
  const refused = await admit(start, ledger);
  if (refused) {
    return json({ error: refused }, 429);
  }
  await seedStore(start);
  const key = caseKeyOf(start);
  const session = await args
    .from(`triage-replay:${start.runId}:${key}`)
    .send(replayMessage(start), { auth: replayAuth(start.runId, key) });
  return json({ caseKey: key, sessionId: session.id });
}

export async function replayResultResponse(
  request: Request
): Promise<Response> {
  const refusal = replayRefusal(request);
  if (refusal) {
    return refusal;
  }
  const url = new URL(request.url);
  const params = {
    caseKey: url.searchParams.get("caseKey") ?? "",
    cohortSha256: url.searchParams.get("cohortSha256") ?? "",
    runId: url.searchParams.get("runId") ?? "",
  };
  const read = await readReplayResult(params);
  return read ? json(read) : json({ error: "No such replay." }, 404);
}

const triageDecisionSchema = z.object({
  decided: z.literal(true),
  decision: z.union([
    z.object({ outcome: z.literal("unproven") }),
    z.object({
      classification: z.string(),
      hotlane: z.object({ route: z.string() }).optional(),
      needsCriticReview: z.boolean(),
      outcome: z.literal("route"),
      path: z.string(),
    }),
  ]),
});

const billingDecisionSchema = z.object({
  decided: z.literal(true),
  decision: z.object({ route: z.object({ project: z.string() }) }),
});

const BILLING_PATH = "Support/Financial";

type FinalDecision =
  | { kind: "billing" }
  | { kind: "unproven" }
  | {
      classification: string;
      kind: "route";
      needsCritic: boolean;
      path: string;
    };

function finalDecision(state: ReplayState): FinalDecision | null {
  for (const entry of [...state.decisions].reverse()) {
    if (entry.kind === "billing") {
      if (billingDecisionSchema.safeParse(entry.output).success) {
        return { kind: "billing" };
      }
      continue;
    }
    const parsed = triageDecisionSchema.safeParse(entry.output);
    if (!(parsed.success && entry.issue === state.case.id)) {
      continue;
    }
    const { decision } = parsed.data;
    if (decision.outcome === "unproven") {
      return { kind: "unproven" };
    }
    return {
      classification: decision.classification,
      kind: "route",
      needsCritic:
        decision.needsCriticReview &&
        decision.hotlane?.route !== "NEEDS_HUMAN_URGENT",
      path: decision.path,
    };
  }
  return null;
}

function reachedTerminal(state: ReplayState, decision: FinalDecision | null) {
  const routed =
    appliedRoute(state).applied &&
    state.routeResults.some(
      (route) => route.routed && route.issue === state.case.id
    );
  switch (decision?.kind) {
    case "unproven":
      return state.documents.length > 0;
    case "billing":
      return routed;
    case "route":
      return routed && (!decision.needsCritic || state.critic !== null);
    default:
      return false;
  }
}

/** A denied tool or an image the case never seeded is a boundary error; any other cancel is a cancelled run. */
const resultStatus = (
  state: ReplayState,
  terminal: boolean
): TriageResult["status"] => {
  if (
    state.cancelled?.startsWith("denied_tool") ||
    state.cancelled?.startsWith(UNSEEDED_IMAGE)
  ) {
    return "boundary_error";
  }
  if (state.cancelled) {
    return "cancelled";
  }
  return state.rootTurn === "completed" && terminal ? "completed" : "failed";
};

export const replaySettled = (state: ReplayState) =>
  state.cancelled !== null || state.rootTurn !== null;

/** What the scorer reads: the last decision for this case, and what the store applied to it. */
export function buildReplayResult(
  state: ReplayState,
  meta: {
    cohortSha256: string;
    run: number;
    runId: string;
  }
): TriageResult {
  const decision = finalDecision(state);
  const applied = appliedRoute(state);
  let final: TriageResult["final"] = null;
  if (decision) {
    const route = decision.kind === "route" ? decision : null;
    final = {
      assignee: applied.assignee,
      classification: route?.classification ?? null,
      duplicateOf: applied.duplicateOf,
      master: applied.master,
      outcome: decision.kind === "unproven" ? "unproven" : "route",
      path: decision.kind === "billing" ? BILLING_PATH : (route?.path ?? null),
      project: applied.project,
    };
  }
  const document = state.documents.at(-1);
  return {
    caseId: state.case.id,
    cohortSha256: meta.cohortSha256,
    critic: state.critic,
    document: document
      ? { text: document.content, updatedAt: document.updatedAt }
      : null,
    evidenceMisses: state.evidenceMisses,
    final,
    inputs: state.inputs,
    listMembershipUnknown: state.listMembershipUnknown,
    run: meta.run,
    runId: meta.runId,
    status: resultStatus(state, reachedTerminal(state, decision)),
  };
}
