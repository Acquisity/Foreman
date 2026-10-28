import { logOpsEvent, type OpsFields } from "../ops-log.js";
import { commentIdFor } from "./comment-id.js";
import {
  composeChange,
  composeDone,
  composeNotFixed,
  composeReceived,
} from "./compose.js";
import {
  coversOf,
  type LedgerStage,
  type Stage,
  stageOfCommentId,
} from "./copy.js";
import type { DeployProbe } from "./deploy.js";
import type { LinearPort, TicketView } from "./linear.js";
import {
  closureOf,
  DEPLOY_REPOSITORY,
  deployVerdict,
  type Planned,
  type PullFacts,
  parsePullUrl,
  type TicketFacts,
} from "./plan.js";
import {
  GIVE_UP_LOG_ATTEMPTS,
  type ReporterStore,
  type WaitCleanup,
} from "./store.js";
import type { ReporterWriter } from "./writer.js";

export interface RunConfig {
  channels: ReadonlySet<string>;
  maxPosts: number;
  runDeadlineMs: number;
  since: string;
}

export interface Deps {
  config: RunConfig;
  deploy: DeployProbe;
  linear: LinearPort;
  log?: (event: string, fields: OpsFields) => void;
  now?: () => number;
  store: ReporterStore;
  write: ReporterWriter;
}

export type Outcome =
  | { kind: "posted"; stage: Stage; waiting?: true }
  | { kind: "recorded"; stage: LedgerStage }
  | { kind: "waiting" }
  | { kind: "held"; why: string }
  | { kind: "skipped"; retryAfter?: number; why: string };

export interface RunReport {
  errors: string[];
  outcomes: { identifier: string; outcome: Outcome }[];
}

const skipped = (why: string): Outcome => ({ kind: "skipped", why });

export const memoize = <T>(load: () => Promise<T>): (() => Promise<T>) => {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load();
    return pending;
  };
};

const stagesInThread = (view: TicketView): Map<LedgerStage, string> => {
  const found = new Map<LedgerStage, string>();
  const { identifier } = view.facts;
  for (const comment of view.foremanComments) {
    const byId = stageOfCommentId(identifier, comment.id);
    for (const stage of [...coversOf(comment.body), ...(byId ? [byId] : [])]) {
      if (!found.has(stage)) {
        found.set(stage, comment.id);
      }
    }
  }
  return found;
};

const recordThreadStages = async (
  view: TicketView,
  inThread: ReadonlyMap<LedgerStage, string>,
  recorded: ReadonlySet<LedgerStage>,
  store: ReporterStore
): Promise<void> => {
  await Promise.all(
    [...inThread]
      .filter(([stage]) => !recorded.has(stage))
      .map(([stage, commentId]) =>
        store.markSent(
          view.facts.identifier,
          [stage],
          view.foremanComments.find((comment) => comment.id === commentId)
            ?.body ?? "",
          view.facts.channel,
          commentId
        )
      )
  );
};

const post = async (
  view: TicketView,
  planned: Planned,
  deps: Deps
): Promise<string> => {
  const id = commentIdFor(view.facts.identifier, planned.stage);
  const anchorId = view.anchorId ?? "";
  try {
    return await deps.linear.postUnderAnchor(
      view.issueId,
      anchorId,
      planned.text,
      id
    );
  } catch (error) {
    const existing = await deps.linear.findComment(id);
    if (existing?.parentId === anchorId) {
      return id;
    }
    throw error;
  }
};

const deliver = async (
  view: TicketView,
  planned: Planned,
  deps: Deps
): Promise<Outcome> => {
  const { identifier, channel } = view.facts;
  const claim = await deps.store.claim(
    identifier,
    planned.stage,
    planned.text,
    channel
  );
  if (!claim.ok) {
    return { kind: "skipped", retryAfter: claim.retryAfter, why: claim.reason };
  }
  let commentId: string;
  try {
    commentId = await post(view, planned, deps);
  } catch (error) {
    await deps.store.release(identifier, planned.stage, claim.token);
    if (claim.attempts >= GIVE_UP_LOG_ATTEMPTS) {
      (deps.log ?? logOpsEvent)("reporter.update.backing_off", {
        code: String(claim.attempts),
        decision: planned.stage,
        outcome: "error",
      });
    }
    throw error;
  }
  const completed = await deps.store.complete(
    identifier,
    planned.stage,
    planned.covers,
    planned.text,
    channel,
    commentId,
    claim.token
  );
  if (!completed) {
    throw new Error(`${identifier}: the ${planned.stage} claim was lost.`);
  }
  return { kind: "posted", stage: planned.stage };
};

const changePlan = async (
  view: TicketView,
  source: TicketFacts,
  pullUrls: readonly string[],
  deps: Deps,
  liveSha: () => Promise<string | null>
): Promise<Planned | Outcome> => {
  const refs = pullUrls.flatMap((url) => parsePullUrl(url) ?? []);
  const [pulls, live] = await Promise.all([
    Promise.all(refs.map((ref) => deps.deploy.pull(ref.repo, ref.number))),
    liveSha(),
  ]);
  const ancestry = new Map<string, boolean>();
  await Promise.all(
    pulls.flatMap((pull: PullFacts) =>
      live &&
      pull.state === "merged" &&
      pull.mergeSha &&
      pull.repo === DEPLOY_REPOSITORY
        ? [
            deps.deploy
              .isAncestor(pull.repo, pull.mergeSha, live)
              .then((result) => {
                ancestry.set(pull.mergeSha as string, result);
              }),
          ]
        : []
    )
  );
  const verdict = deployVerdict(pulls, live, ancestry);
  if (verdict === "live") {
    return composeChange(source, pulls, deps.write);
  }
  if (verdict === "waiting") {
    await deps.store.markWaiting(view.facts.identifier, live);
    return { kind: "waiting" };
  }
  return { kind: "held", why: verdict };
};

const isPlanned = (value: Planned | Outcome): value is Planned =>
  "stage" in value && "text" in value;

const gate = (view: TicketView, deps: Deps): Outcome | null => {
  const { facts } = view;
  if (Date.parse(facts.createdAt) < Date.parse(deps.config.since)) {
    return skipped("before_cutoff");
  }
  if (view.undeliverable) {
    if (
      view.undeliverable.some((channel) => deps.config.channels.has(channel))
    ) {
      (deps.log ?? logOpsEvent)("reporter.update.undeliverable", {
        code: "foreign_thread",
        message: `${facts.identifier} first Ask thread belongs to another ticket, so the receiver would deliver nowhere.`,
        outcome: "skipped",
      });
      return skipped("undeliverable");
    }
    return skipped("channel_not_enabled");
  }
  if (!(facts.channel && deps.config.channels.has(facts.channel))) {
    return skipped("channel_not_enabled");
  }
  return null;
};

export const reconcileTicket = async (
  identifier: string,
  deps: Deps,
  liveSha: () => Promise<string | null>
): Promise<Outcome> => {
  const view = await deps.linear.readTicket(identifier);
  if (!view) {
    return skipped("not_found");
  }
  const { facts } = view;
  if (!view.anchorId) {
    return skipped("no_thread");
  }
  const refusal = gate(view, deps);
  if (refusal) {
    return refusal;
  }
  const rows = await deps.store.rows(identifier);
  const inThread = stagesInThread(view);
  const recorded = new Set(
    rows.filter((row) => row.status === "sent").map((row) => row.stage)
  );
  const unrecorded = [...inThread.keys()].filter(
    (stage) => !recorded.has(stage)
  );
  await recordThreadStages(view, inThread, recorded, deps.store);
  const done = new Set<LedgerStage>([...recorded, ...inThread.keys()]);
  const planned = await nextMessage(view, done, deps, liveSha);
  if (planned === null) {
    const [stage] = unrecorded;
    return stage ? { kind: "recorded", stage } : skipped("nothing_due");
  }
  if (!isPlanned(planned)) {
    return planned;
  }
  const outcome = await deliver(view, planned, deps);
  const closure = closureOf(facts);
  if (
    outcome.kind === "posted" &&
    planned.stage === "not_fixed" &&
    facts.duplicateOf &&
    closure.kind === "not_fixed" &&
    closure.reason === "duplicate"
  ) {
    await deps.store.markWaiting(facts.identifier, null);
    return { ...outcome, waiting: true };
  }
  return outcome;
};

/**
 * What a duplicate follows: its master (ENG-16608) and its match. The master's
 * outcome governs: a Canceled master ends the wait whatever the match shows,
 * and a failed master read keeps the wait for the next run. Otherwise the
 * fixing pull request may be linked to either, so their linked pull requests
 * are pooled; a failed match read never hides the master.
 */
/** The Linear read of what a duplicate follows failed; nothing else is one. */
class FollowedReadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "FollowedReadError";
  }
}

const followedOriginal = async (
  master: string | undefined,
  match: string | null,
  deps: Deps
): Promise<TicketFacts | null> => {
  const wanted = [...new Set([master, match].filter((id) => !!id))] as string[];
  const results = await Promise.allSettled(
    wanted.map((id) => deps.linear.readOriginal(id))
  );
  const read = results.flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : []
  );
  // The master is read first and decides: when its read fails the duplicate
  // keeps waiting and is retried, never decided from the match alone.
  const [masterRead] = results;
  if (master && masterRead?.status === "rejected") {
    throw new FollowedReadError(masterRead.reason);
  }
  const failed = results.find((result) => result.status === "rejected");
  if (failed && read.length === 0) {
    throw new FollowedReadError(failed.reason);
  }
  const governing = read.find((facts) => facts.identifier === master);
  if (governing && closureOf(governing).kind === "not_fixed") {
    return governing;
  }
  const fixed = read.filter(
    (facts) => closureOf(facts).kind === "needs_deploy"
  );
  const [first] = fixed;
  return first
    ? { ...first, pullUrls: [...new Set(fixed.flatMap((f) => f.pullUrls))] }
    : (governing ?? read[0] ?? null);
};

const originalFollowUp = async (
  view: TicketView,
  deps: Deps,
  liveSha: () => Promise<string | null>
): Promise<Planned | Outcome | null> => {
  const { duplicateOf, identifier, parent } = view.facts;
  const original = await followedOriginal(
    parent?.identifier,
    duplicateOf,
    deps
  );
  if (!original) {
    return null;
  }
  const closure = closureOf(original);
  if (closure.kind === "needs_deploy") {
    return changePlan(view, original, closure.pullUrls, deps, liveSha);
  }
  if (closure.kind === "not_fixed") {
    return dropDuplicate(
      identifier,
      original.stateType === "canceled"
        ? "original_canceled"
        : "original_not_fixed",
      deps
    );
  }
  if (closure.kind === "done_without_pull") {
    const done = await composeDone(view.facts, deps.write);
    if (done) {
      return done;
    }
  }
  await deps.store.markWaiting(identifier, await liveSha());
  return { kind: "waiting" };
};

/**
 * The fixed, live or done message for a duplicate once its master, or its
 * original when it has no master, has one. Until then the duplicate waits,
 * for at most 30 days after it was closed, whatever that is waiting on.
 */
const duplicateFollowUp = async (
  view: TicketView,
  deps: Deps,
  liveSha: () => Promise<string | null>
): Promise<Planned | Outcome | null> => {
  const closedAt = Date.parse(view.facts.closedAt ?? "");
  const expired =
    !Number.isNaN(closedAt) &&
    (deps.now ?? Date.now)() - closedAt > DUPLICATE_WAIT_MS;
  // Past the limit, a master or match that cannot be read ends the wait too,
  // so a Linear read that keeps failing never keeps a duplicate waiting
  // forever; any other failure (a deploy check, the writer) is retried.
  const next = await originalFollowUp(view, deps, liveSha).catch(
    (error: unknown) => {
      if (expired && error instanceof FollowedReadError) {
        return WAITING;
      }
      throw error;
    }
  );
  return next !== null && !isPlanned(next) && next.kind === "waiting" && expired
    ? dropDuplicate(view.facts.identifier, "expired", deps)
    : next;
};

const DUPLICATE_WAIT_MS = 30 * 86_400_000;
const WAITING = { kind: "waiting" } as const;

const dropDuplicate = (identifier: string, code: string, deps: Deps): null => {
  (deps.log ?? logOpsEvent)("reporter.update.duplicate_dropped", {
    code,
    issue: identifier,
    outcome: "skipped",
  });
  return null;
};

const skipDone = (view: TicketView, deps: Deps): Outcome => {
  (deps.log ?? logOpsEvent)("reporter.update_skipped", {
    code: "no_evidence_of_change",
    issue: view.facts.identifier,
    outcome: "skipped",
  });
  return skipped("no_evidence_of_change");
};

const nextMessage = async (
  view: TicketView,
  done: ReadonlySet<LedgerStage>,
  deps: Deps,
  liveSha: () => Promise<string | null>
): Promise<Planned | Outcome | null> => {
  const { facts } = view;
  const closure = closureOf(facts);
  if (closure.kind === "open") {
    return done.has("received") ? null : composeReceived(facts, deps.write);
  }
  if (closure.kind === "not_fixed") {
    if (!done.has("not_fixed")) {
      return composeNotFixed(facts, closure.reason, deps.write);
    }
    return closure.reason === "duplicate" && !done.has("fixed")
      ? duplicateFollowUp(view, deps, liveSha)
      : null;
  }
  if (done.has("fixed")) {
    return null;
  }
  if (closure.kind === "needs_deploy") {
    return changePlan(view, facts, closure.pullUrls, deps, liveSha);
  }
  if (done.has("not_fixed")) {
    return null;
  }
  return (await composeDone(facts, deps.write)) ?? skipDone(view, deps);
};

const CURSOR_OVERLAP_MS = 600_000;
const PENDING_BATCH = 100;

const settle = async (
  identifier: string,
  deps: Deps,
  liveSha: () => Promise<string | null>
): Promise<{ error?: string; identifier: string; outcome?: Outcome }> => {
  try {
    return {
      identifier,
      outcome: await reconcileTicket(identifier, deps, liveSha),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Unknown failure.",
      identifier,
    };
  }
};

const KEEP_PENDING = new Set(["backing_off", "busy", "undeliverable"]);

const waitCleanup = async (
  outcome: Outcome,
  liveSha: () => Promise<string | null>
): Promise<WaitCleanup> => {
  if (
    outcome.kind === "waiting" ||
    (outcome.kind === "posted" && outcome.waiting)
  ) {
    return { kind: "keep" };
  }
  if (outcome.kind === "skipped" && outcome.why === "channel_not_enabled") {
    const live = await liveSha().catch(() => null);
    return live ? { kind: "stamp", sha: live } : { kind: "keep" };
  }
  return { kind: "drop" };
};

const SWEEP_MAX_AGE_MS = 86_400_000;

const discoverTickets = async (
  deps: Deps,
  nowMs: number,
  report: RunReport
): Promise<void> => {
  try {
    const cursor = await deps.store.readCursor();
    const created = Date.parse(deps.config.since);
    const resume =
      cursor.sweep && nowMs - cursor.sweep.startedAt < SWEEP_MAX_AGE_MS
        ? cursor.sweep
        : null;
    const updatedSince = resume
      ? resume.since
      : Math.max(cursor.since ?? created, created);
    const startedAt = resume ? resume.startedAt : nowMs;
    const found = await deps.linear.discover(
      new Date(updatedSince).toISOString(),
      deps.config.since,
      resume?.after ?? null
    );
    await deps.store.enqueue(found.tickets);
    if (found.next === null) {
      await deps.store.saveCursor(startedAt - CURSOR_OVERLAP_MS);
    } else {
      await deps.store.saveSweep({
        after: found.next,
        since: updatedSince,
        startedAt,
      });
    }
  } catch (error) {
    report.errors.push(
      `discovery: ${error instanceof Error ? error.message : "Unknown failure."}`
    );
  }
};

export const runReporterUpdates = async (
  deps: Deps,
  nowMs: number,
  clock: () => number = Date.now
): Promise<RunReport> => {
  const report: RunReport = { errors: [], outcomes: [] };
  const liveSha = memoize(() => deps.deploy.liveSha());
  await discoverTickets(deps, nowMs, report);
  try {
    if (await deps.store.anyWaiting()) {
      await deps.store.queueWaiting(await liveSha().catch(() => null));
    }
  } catch (error) {
    report.errors.push(
      `waiting: ${error instanceof Error ? error.message : "Unknown failure."}`
    );
  }
  const todo = await deps.store.nextPending(PENDING_BATCH);
  let posts = 0;
  await todo.reduce(async (previous, pending) => {
    await previous;
    const identifier = pending.issue;
    if (
      posts >= deps.config.maxPosts ||
      clock() - nowMs >= deps.config.runDeadlineMs
    ) {
      return;
    }
    const result = await settle(identifier, deps, liveSha);
    if (result.error) {
      report.errors.push(`${result.identifier}: ${result.error}`);
      await deps.store.failPending(pending);
      return;
    }
    if (!result.outcome) {
      return;
    }
    report.outcomes.push({ identifier, outcome: result.outcome });
    posts += result.outcome.kind === "posted" ? 1 : 0;
    if (
      result.outcome.kind === "skipped" &&
      result.outcome.retryAfter !== undefined
    ) {
      await deps.store.deferPending(pending, result.outcome.retryAfter);
    } else if (
      result.outcome.kind === "skipped" &&
      KEEP_PENDING.has(result.outcome.why)
    ) {
      await deps.store.failPending(pending);
    } else {
      await deps.store.resolvePending(
        pending,
        await waitCleanup(result.outcome, liveSha)
      );
    }
  }, Promise.resolve());
  return report;
};
