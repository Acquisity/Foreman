import { type Stage, stageOfBody } from "./copy.js";
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
  lookbackMs: number;
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
  for (const comment of view.foremanComments) {
    const stage = stageOfBody(comment.body);
    if (stage && !found.has(stage)) {
      found.set(stage, comment.id);
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

const deliver = async (
  view: TicketView,
  planned: Planned,
  deps: Deps
): Promise<Outcome> => {
  const { identifier, channel } = view.facts;
  const claimed = await deps.store.claim(
    identifier,
    planned.stage,
    planned.text,
    channel
  );
  if (!claimed) {
    return skipped("claimed_elsewhere");
  }
  let commentId: string;
  try {
    commentId = await deps.linear.postUnderAnchor(
      view.issueId,
      view.anchorId ?? "",
      planned.text
    );
  } catch (error) {
    await deps.store.release(identifier, planned.stage);
    throw error;
  }
  await deps.store.markSent(
    identifier,
    planned.covers,
    planned.text,
    channel,
    commentId
  );
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

export const runReporterUpdates = async (
  deps: Deps,
  nowMs: number,
  clock: () => number = Date.now
): Promise<RunReport> => {
  const sinceIso = new Date(nowMs - deps.config.lookbackMs).toISOString();
  const [recent, waiting] = await Promise.all([
    deps.linear.recentIdentifiers(sinceIso, deps.config.since),
    deps.store.listWaiting(),
  ]);
  const liveSha = memoize(() => deps.deploy.liveSha());
  const live = waiting.length > 0 ? await liveSha().catch(() => null) : null;
  const recentSet = new Set(recent);
  const todo = [
    ...recentSet,
    ...waiting
      .filter(
        (ticket) =>
          !(
            recentSet.has(ticket.issue) ||
            (ticket.checkedSha && ticket.checkedSha === live)
          )
      )
      .map((ticket) => ticket.issue),
  ];
  const report: RunReport = { errors: [], outcomes: [] };
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
    } else if (result.outcome) {
      report.outcomes.push({
        identifier: result.identifier,
        outcome: result.outcome,
      });
      posts += result.outcome.kind === "posted" ? 1 : 0;
    }
  }, Promise.resolve());
  return report;
};
