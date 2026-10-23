import { ThreadIncompleteError } from "../requester-reply.js";
import { commentIdFor } from "./comment-id.js";
import { coversOf, STAGES, type Stage } from "./copy.js";
import type { DeployProbe } from "./deploy.js";
import type { LinearPort, TicketView } from "./linear.js";
import {
  closureOf,
  DEPLOY_REPOSITORY,
  deployVerdict,
  type Planned,
  type PullFacts,
  parsePullUrl,
  planEarly,
  planFixed,
  planNotFixed,
} from "./plan.js";
import type { ReporterStore } from "./store.js";

export interface RunConfig {
  channels: ReadonlySet<string>;
  maxPosts: number;
  nameOwner: boolean;
  runDeadlineMs: number;
  since: string;
}

export interface Deps {
  config: RunConfig;
  deploy: DeployProbe;
  linear: LinearPort;
  store: ReporterStore;
}

export type Outcome =
  | { kind: "posted"; stage: Stage }
  | { kind: "recorded"; stage: Stage }
  | { kind: "waiting" }
  | { kind: "held"; why: string }
  | { kind: "skipped"; why: string };

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

const stagesInThread = (view: TicketView): Map<Stage, string> => {
  const found = new Map<Stage, string>();
  const { identifier } = view.facts;
  for (const comment of view.foremanComments) {
    const byId = STAGES.filter(
      (stage) => commentIdFor(identifier, stage) === comment.id
    );
    for (const stage of [...coversOf(comment.body), ...byId]) {
      if (!found.has(stage)) {
        found.set(stage, comment.id);
      }
    }
  }
  return found;
};

const recordThreadStages = async (
  view: TicketView,
  inThread: ReadonlyMap<Stage, string>,
  recorded: ReadonlySet<Stage>,
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
    return skipped(
      claim.reason === "exhausted" ? "retries_exhausted" : "claimed_elsewhere"
    );
  }
  let commentId: string;
  try {
    commentId = await post(view, planned, deps);
  } catch (error) {
    await deps.store.release(identifier, planned.stage, claim.token);
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

const fixedPlan = async (
  view: TicketView,
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
    return planFixed();
  }
  if (verdict === "waiting") {
    await deps.store.markWaiting(view.facts.identifier, live);
    return { kind: "waiting" };
  }
  return { kind: "held", why: verdict };
};

const isPlanned = (value: Planned | Outcome): value is Planned =>
  "stage" in value && "text" in value;

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
  if (!(facts.channel && deps.config.channels.has(facts.channel))) {
    return skipped("channel_not_enabled");
  }
  if (Date.parse(facts.createdAt) < Date.parse(deps.config.since)) {
    return skipped("before_cutoff");
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
  const done = new Set<Stage>([...recorded, ...inThread.keys()]);
  const closure = closureOf(facts);
  let planned: Planned | Outcome | null = null;
  if (closure.kind === "open") {
    planned = planEarly(facts, done, deps.config.nameOwner);
  } else if (closure.kind === "not_fixed") {
    planned = done.has("not_fixed") ? null : planNotFixed(closure.reason);
  } else if (closure.kind === "needs_deploy") {
    planned = done.has("fixed")
      ? null
      : await fixedPlan(view, closure.pullUrls, deps, liveSha);
  } else {
    return { kind: "held", why: closure.why };
  }
  if (planned === null) {
    const [stage] = unrecorded;
    return stage ? { kind: "recorded", stage } : skipped("nothing_due");
  }
  if (!isPlanned(planned)) {
    return planned;
  }
  return deliver(view, planned, deps);
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
    if (error instanceof ThreadIncompleteError) {
      return { identifier, outcome: skipped("thread_incomplete") };
    }
    return {
      error: error instanceof Error ? error.message : "Unknown failure.",
      identifier,
    };
  }
};

const KEEP_PENDING = new Set(["claimed_elsewhere"]);

const discoverTickets = async (
  deps: Deps,
  nowMs: number,
  report: RunReport
): Promise<void> => {
  try {
    const cursor = await deps.store.readCursor();
    const created = Date.parse(deps.config.since);
    const updatedSince = new Date(Math.max(cursor ?? created, created));
    const found = await deps.linear.discover(
      updatedSince.toISOString(),
      deps.config.since
    );
    await deps.store.enqueue(found.identifiers);
    if (found.complete) {
      await deps.store.saveCursor(nowMs - CURSOR_OVERLAP_MS);
    } else {
      report.errors.push("discovery: more tickets than one run can list.");
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
      const live = await liveSha().catch(() => null);
      if (live) {
        await deps.store.queueWaiting(live);
      }
    }
  } catch (error) {
    report.errors.push(
      `waiting: ${error instanceof Error ? error.message : "Unknown failure."}`
    );
  }
  const todo = await deps.store.nextPending(PENDING_BATCH);
  let posts = 0;
  await todo.reduce(async (previous, identifier) => {
    await previous;
    if (
      posts >= deps.config.maxPosts ||
      clock() - nowMs >= deps.config.runDeadlineMs
    ) {
      return;
    }
    const result = await settle(identifier, deps, liveSha);
    if (result.error) {
      report.errors.push(`${result.identifier}: ${result.error}`);
      await deps.store.failPending(identifier);
      return;
    }
    if (!result.outcome) {
      return;
    }
    report.outcomes.push({ identifier, outcome: result.outcome });
    posts += result.outcome.kind === "posted" ? 1 : 0;
    if (
      result.outcome.kind === "skipped" &&
      KEEP_PENDING.has(result.outcome.why)
    ) {
      await deps.store.failPending(identifier);
    } else {
      await deps.store.resolvePending(identifier);
    }
  }, Promise.resolve());
  return report;
};
