import { createHash, timingSafeEqual } from "node:crypto";
import type { SessionAuthContext } from "eve/context";
import { z } from "zod";
import { readDocument, TRIAGE_REPLAY_PREFIX, writeDocument } from "../blob.js";
import { logOpsEvent } from "../ops-log.js";
import { BILLING_PATH } from "../triage-log.js";
import { stampTriageIntake, stampUnattended } from "../trust.js";
import {
  loadReplayState,
  ReplayStateConflictError,
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
  frozenListsSchema,
  type ReplayStamp,
  type ReplayState,
  seedReplayState,
} from "./store.js";
import { appliedRoute } from "./views.js";

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

/**
 * The admission ledger: the starts this approved run has used, the starts
 * reserved but not yet dispatched (with when each was reserved), and the model
 * spend charged for both, with the version read.
 */
export interface LedgerEntries {
  admitted: string[];
  chargedUsd: number;
  reserved: Record<string, number>;
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
  reserved: z.record(z.string(), z.number()).default({}),
});

export const blobLedger: AdmissionLedger = {
  async read(runId) {
    const result = await readDocument(ledgerKey(runId), { access: "private" });
    return result.found
      ? { ...ledgerSchema.parse(JSON.parse(result.content)), etag: result.etag }
      : { admitted: [], chargedUsd: 0, etag: null, reserved: {} };
  },
  write: (runId, entries, etag) =>
    writeDocument(ledgerKey(runId), JSON.stringify(entries), {
      access: "private",
      contentType: "application/json",
      ifMatch: etag,
    }),
};

const ADMISSION_ATTEMPTS = 8;
/** How long a reservation blocks a second start of the same case and run. */
export const RESERVATION_LEASE_MS = 120_000;

interface Allowance {
  costPerCase: number;
  maxRuns: number;
  maxUsd: number;
}

const usd = (value: number) => `$${value.toFixed(2)}`;

const positive = (value: string | undefined) => {
  const parsed = Number(value);
  return value && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

async function updateLedger(
  runId: string,
  ledger: AdmissionLedger,
  change: (entries: LedgerEntries) => LedgerEntries | string,
  attempt = 0
): Promise<string | null> {
  if (attempt >= ADMISSION_ATTEMPTS) {
    return "The admission ledger kept changing, so this start is refused.";
  }
  const { etag, ...entries } = await ledger.read(runId);
  const next = change({ ...entries, reserved: entries.reserved ?? {} });
  if (typeof next === "string") {
    return next;
  }
  return (await ledger.write(runId, next, etag)) === "written"
    ? null
    : updateLedger(runId, ledger, change, attempt + 1);
}

function allowanceOf(env: NodeJS.ProcessEnv): Allowance | string {
  const maxUsd = positive(env.TRIAGE_REPLAY_MAX_USD);
  const costPerCase = positive(env.TRIAGE_REPLAY_EST_USD_PER_CASE);
  if (maxUsd === null || costPerCase === null) {
    return "TRIAGE_REPLAY_MAX_USD and TRIAGE_REPLAY_EST_USD_PER_CASE must both be set on the server.";
  }
  return {
    costPerCase,
    maxRuns: Number(env.TRIAGE_REPLAY_MAX_RUNS ?? 3),
    maxUsd,
  };
}

/**
 * Reserves one start for the approved run, or says why not. A reservation
 * holds a slot and its estimated spend until `confirm` or `release`; a lost
 * race rereads the ledger. A second start of the same case and run is refused
 * while the first holds a fresh reservation, and may reuse one that has gone
 * stale without charging again.
 */
export function reserve(
  request: StartRequest,
  ledger: AdmissionLedger,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now()
): Promise<string | null> {
  if (!env.TRIAGE_REPLAY_RUN_ID || request.runId !== env.TRIAGE_REPLAY_RUN_ID) {
    return Promise.resolve(
      "This run id is not the one approved on the server."
    );
  }
  const allowance = allowanceOf(env);
  if (typeof allowance === "string") {
    return Promise.resolve(allowance);
  }
  const entry = caseKeyOf(request);
  return updateLedger(request.runId, ledger, (entries) => {
    if (entries.admitted.includes(entry)) {
      return `${entry} was already started in this run.`;
    }
    const reservedAt = entries.reserved[entry];
    if (reservedAt !== undefined) {
      return now - reservedAt < RESERVATION_LEASE_MS
        ? `${entry} is already starting in this run.`
        : { ...entries, reserved: { ...entries.reserved, [entry]: now } };
    }
    if (
      entries.admitted.length + Object.keys(entries.reserved).length >=
      allowance.maxRuns
    ) {
      return `This run has used its ${allowance.maxRuns} admitted replays.`;
    }
    if (entries.chargedUsd + allowance.costPerCase > allowance.maxUsd) {
      return `This run has charged an estimated ${usd(entries.chargedUsd)} of its ${usd(allowance.maxUsd)} model spend cap, and another case would add ${usd(allowance.costPerCase)}.`;
    }
    return {
      admitted: entries.admitted,
      chargedUsd: entries.chargedUsd + allowance.costPerCase,
      reserved: { ...entries.reserved, [entry]: now },
    };
  });
}

async function settle(
  request: StartRequest,
  ledger: AdmissionLedger,
  change: (entries: LedgerEntries, entry: string) => LedgerEntries
) {
  const entry = caseKeyOf(request);
  const problem = await updateLedger(request.runId, ledger, (entries) =>
    change(entries, entry)
  );
  if (problem) {
    throw new Error(problem);
  }
}

const withoutReservation = (entries: LedgerEntries, entry: string) => {
  const { [entry]: _held, ...reserved } = entries.reserved;
  return reserved;
};

/** Turns a reservation into an admitted start once its session has been dispatched. */
export const confirm = (request: StartRequest, ledger: AdmissionLedger) =>
  settle(request, ledger, (entries, entry) => ({
    admitted: entries.admitted.includes(entry)
      ? entries.admitted
      : [...entries.admitted, entry],
    chargedUsd: entries.chargedUsd,
    reserved: withoutReservation(entries, entry),
  }));

/** Gives a reservation's slot and estimated spend back when its start failed before dispatch. */
export const release = (
  request: StartRequest,
  ledger: AdmissionLedger,
  env: NodeJS.ProcessEnv = process.env
) =>
  settle(request, ledger, (entries, entry) => {
    if (entries.reserved[entry] === undefined) {
      return entries;
    }
    const allowance = allowanceOf(env);
    return {
      admitted: entries.admitted,
      chargedUsd:
        typeof allowance === "string"
          ? entries.chargedUsd
          : Math.max(0, entries.chargedUsd - allowance.costPerCase),
      reserved: withoutReservation(entries, entry),
    };
  });

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

/** What a replay's result records about the server that ran it. */
export const replayStamp = (
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date()
): ReplayStamp => ({
  estimatedUsd: positive(env.TRIAGE_REPLAY_EST_USD_PER_CASE) ?? 0,
  foremanCommit: env.VERCEL_GIT_COMMIT_SHA?.trim() || "unknown",
  startedAt: now.toISOString(),
});

const neverDispatched = (state: ReplayState) =>
  state.steps === 0 && state.rootTurn === null && state.cancelled === null;

/**
 * Seeds the case's store. A store left by a start that failed before its
 * session ran is reused, and given its seed input if that was what failed;
 * one a session has touched is refused.
 */
export async function seedStore(request: StartRequest, stamp: ReplayStamp) {
  const key = replayStateKey(request.runId, caseKeyOf(request));
  const seed = seedReplayState(
    request.case,
    request.lists,
    request.archiveUrl,
    request.cohortSha256,
    stamp
  );
  const backend = replayBackend();
  const stored = await backend.read(key);
  if (!stored) {
    await seedReplayStore(key, seed);
    return;
  }
  if (!neverDispatched(stored.state)) {
    throw new ReplayStateConflictError(key);
  }
  if ((await backend.listInputs(key)).length === 0) {
    await backend.appendInputs(key, seed.inputs);
  }
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
  const refused = await reserve(start, ledger);
  if (refused) {
    return json({ error: refused }, 429);
  }
  const key = caseKeyOf(start);
  let session: { id: string };
  try {
    await seedStore(start, replayStamp());
    session = await args
      .from(`triage-replay:${start.runId}:${key}`)
      .send(replayMessage(start), { auth: replayAuth(start.runId, key) });
  } catch (error) {
    try {
      await release(start, ledger);
    } catch (releaseError) {
      throw new Error(
        `Replay ${key} failed to start (${String(error)}), and its reservation could not be released.`,
        { cause: releaseError }
      );
    }
    throw error;
  }
  try {
    await confirm(start, ledger);
  } catch {
    logOpsEvent("triage_replay.ledger_unconfirmed", {
      sessionId: session.id,
    });
  }
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
    estimatedUsd: state.stamp.estimatedUsd,
    evidenceMisses: state.evidenceMisses,
    final,
    foremanCommit: state.stamp.foremanCommit,
    inputs: state.inputs,
    listMembershipUnknown: state.listMembershipUnknown,
    run: meta.run,
    runId: meta.runId,
    startedAt: state.stamp.startedAt,
    status: resultStatus(state, reachedTerminal(state, decision)),
  };
}
