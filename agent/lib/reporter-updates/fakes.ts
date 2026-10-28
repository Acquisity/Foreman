import { fixedText, type LedgerStage, receivedText } from "./copy.js";
import type { DeployProbe } from "./deploy.js";
import type { LinearPort, TicketView } from "./linear.js";
import { DEPLOY_REPOSITORY, type PullFacts, type TicketFacts } from "./plan.js";
import { type Deps, type RunConfig, reconcileTicket } from "./run.js";
import {
  backoffMs,
  type LedgerRow,
  type PendingTicket,
  type ReporterStore,
  WAITING_RECHECK_MS,
} from "./store.js";
import type { ReporterWriter, WriterReply, WriterTask } from "./writer.js";

export const SANDBOX = "C0AAAAAAAAA";
export const FOREMAN = "foreman-user";
export const OLD_SHA = "1111111111111111111111111111111111111111";
export const NEW_SHA = "2222222222222222222222222222222222222222";
export const MERGE_SHA = "3333333333333333333333333333333333333333";
export const PR_URL = `https://github.com/${DEPLOY_REPOSITORY}/pull/7`;
export const NOW = Date.parse("2026-10-20T12:00:00Z");

export const merged = (over: Partial<PullFacts> = {}): PullFacts => ({
  body: "## Solution\nThe export now includes every row.",
  mergeSha: MERGE_SHA,
  number: 7,
  repo: DEPLOY_REPOSITORY,
  state: "merged",
  title: "fix(crm): export every row",
  ...over,
});

export const STUB: Record<WriterTask["kind"], WriterReply> = {
  done: { steps: null, what: "that number's been removed from the CRM" },
  fixed: { steps: null, what: "the export now includes every row" },
  live: {
    steps: "Open People and click Export.",
    what: "you can now export every row",
  },
  reason: { steps: null, what: null },
  received: { steps: null, what: "why your export is missing rows" },
};

export const RECEIVED = receivedText(STUB.received.what);
export const FIXED = fixedText(STUB.fixed.what, null);

/** A stub `writer` that answers each task kind from `replies`, and records the tasks. */
export const fakeWriter = (
  replies: Partial<Record<WriterTask["kind"], WriterReply>> = {}
) => {
  const tasks: WriterTask[] = [];
  const write: ReporterWriter = (task) => {
    tasks.push(task);
    return Promise.resolve(replies[task.kind] ?? STUB[task.kind]);
  };
  return { tasks, write };
};

export const pullKey = (number: number) => `${DEPLOY_REPOSITORY}#${number}`;

export const config = (over: Partial<RunConfig> = {}): RunConfig => ({
  channels: new Set([SANDBOX]),
  maxPosts: 20,
  runDeadlineMs: 240_000,
  since: "2026-10-01T00:00:00.000Z",
  ...over,
});

export const facts = (over: Partial<TicketFacts> = {}): TicketFacts => ({
  assignee: "Sam Jones",
  channel: SANDBOX,
  closedAt: null,
  closingComments: [],
  createdAt: "2026-10-10T10:00:00.000Z",
  description: "Exports stop at 500 rows.",
  duplicateOf: null,
  identifier: "ENG-1",
  labels: [],
  parent: null,
  pullUrls: [],
  stateName: "Todo",
  stateType: "unstarted",
  title: "Export is missing rows",
  ...over,
});

interface StoredRow extends LedgerRow {
  attempts: number;
  claimedAt: number;
  message: string;
  retryAfter: number;
  token: string | null;
  updatedAt: number;
}

export const memoryStore = () => {
  const table = new Map<string, StoredRow>();
  const key = (issue: string, stage: LedgerStage) => `${issue}|${stage}`;
  const pending = new Map<
    string,
    {
      attempts: number;
      lastTry: number;
      retryAfter: number;
      version: number | null;
    }
  >();
  const current = ({ issue, version }: PendingTicket) => {
    const entry = pending.get(issue);
    return entry?.version === version ? entry : undefined;
  };
  const state: {
    cursor: number | null;
    cursorWrites: number[];
    sweep: { after: string; since: number; startedAt: number } | null;
    failNextEnqueue: boolean;
    failNextMarkSent: boolean;
    failNextResolve: boolean;
    now: number;
    tokens: number;
  } = {
    cursor: null,
    cursorWrites: [],
    failNextEnqueue: false,
    failNextMarkSent: false,
    failNextResolve: false,
    now: 0,
    sweep: null,
    tokens: 0,
  };
  const blank = (stage: LedgerStage): StoredRow => ({
    attempts: 0,
    checkedSha: null,
    claimedAt: 0,
    commentId: null,
    message: "",
    retryAfter: 0,
    stage,
    status: "waiting",
    token: null,
    updatedAt: 0,
  });
  const markSent: ReporterStore["markSent"] = (
    issue,
    stages,
    message,
    _channel,
    commentId
  ) => {
    if (state.failNextMarkSent) {
      state.failNextMarkSent = false;
      return Promise.reject(new Error("database unavailable"));
    }
    for (const stage of stages) {
      table.set(key(issue, stage), {
        ...(table.get(key(issue, stage)) ?? blank(stage)),
        commentId,
        message,
        status: "sent",
        token: null,
      });
    }
    return Promise.resolve();
  };
  const store: ReporterStore = {
    anyWaiting() {
      return Promise.resolve(
        [...table.entries()].some(
          ([k, row]) => k.endsWith("|fixed") && row.status === "waiting"
        )
      );
    },
    claim(issue, stage, message) {
      const existing = table.get(key(issue, stage));
      const stale =
        existing?.status === "claimed" &&
        state.now - existing.claimedAt > 600_000;
      if (existing?.status === "sent") {
        return Promise.resolve({ ok: false, reason: "busy", retryAfter: 0 });
      }
      if (existing?.status === "waiting" && existing.retryAfter > state.now) {
        return Promise.resolve({
          ok: false,
          reason: "backing_off",
          retryAfter: existing.retryAfter,
        });
      }
      if (existing && existing.status !== "waiting" && !stale) {
        return Promise.resolve({
          ok: false,
          reason: "busy",
          retryAfter: existing.claimedAt + 600_000,
        });
      }
      state.tokens += 1;
      const token = `token-${state.tokens}`;
      table.set(key(issue, stage), {
        ...(existing ?? blank(stage)),
        attempts: (existing?.attempts ?? 0) + 1,
        claimedAt: state.now,
        message,
        retryAfter: 0,
        status: "claimed",
        token,
      });
      return Promise.resolve({
        attempts: (existing?.attempts ?? 0) + 1,
        ok: true,
        token,
      });
    },
    async complete(issue, stage, covers, message, channel, commentId, token) {
      const existing = table.get(key(issue, stage));
      if (existing?.token !== token || existing.status !== "claimed") {
        return false;
      }
      await markSent(issue, covers, message, channel, commentId);
      return true;
    },
    deferPending(item, untilMs) {
      const entry = current(item);
      if (entry) {
        state.tokens += 1;
        pending.set(item.issue, {
          ...entry,
          lastTry: state.tokens,
          retryAfter: Math.max(entry.retryAfter, untilMs),
        });
      }
      return Promise.resolve();
    },
    enqueue(tickets) {
      if (state.failNextEnqueue) {
        state.failNextEnqueue = false;
        return Promise.reject(new Error("database unavailable"));
      }
      for (const { issue, version } of tickets) {
        const existing = pending.get(issue);
        if (
          existing &&
          existing.version !== null &&
          version <= existing.version
        ) {
          continue;
        }
        pending.set(issue, {
          attempts: 0,
          lastTry: existing?.lastTry ?? 0,
          retryAfter: 0,
          version,
        });
        for (const [k, row] of table.entries()) {
          if (k.startsWith(`${issue}|`) && row.status === "waiting") {
            table.set(k, { ...row, attempts: 0, retryAfter: 0 });
          }
        }
      }
      return Promise.resolve();
    },
    failPending(item) {
      const entry = current(item);
      if (entry) {
        state.tokens += 1;
        pending.set(item.issue, {
          attempts: entry.attempts + 1,
          lastTry: state.tokens,
          retryAfter: Math.max(
            entry.retryAfter,
            state.now + backoffMs(entry.attempts)
          ),
          version: entry.version,
        });
      }
      return Promise.resolve();
    },
    markSent,
    markWaiting(issue, checkedSha) {
      const existing = table.get(key(issue, "fixed"));
      if (!existing || existing.status === "waiting") {
        table.set(key(issue, "fixed"), {
          ...(existing ?? blank("fixed")),
          checkedSha,
          status: "waiting",
          updatedAt: state.now,
        });
      }
      return Promise.resolve();
    },
    nextPending(limit) {
      return Promise.resolve(
        [...pending.entries()]
          .filter(([, entry]) => entry.retryAfter <= state.now)
          .sort((a, b) => a[1].lastTry - b[1].lastTry)
          .slice(0, limit)
          .map(([issue, entry]) => ({ issue, version: entry.version }))
      );
    },
    queueWaiting(liveSha) {
      for (const [k, row] of table.entries()) {
        if (
          k.endsWith("|fixed") &&
          row.status === "waiting" &&
          ((liveSha !== null && row.checkedSha !== liveSha) ||
            state.now - row.updatedAt >= WAITING_RECHECK_MS) &&
          !pending.has(k.split("|")[0] ?? "")
        ) {
          pending.set(k.split("|")[0] ?? "", {
            attempts: 0,
            lastTry: 0,
            retryAfter: 0,
            version: null,
          });
        }
      }
      return Promise.resolve();
    },
    readCursor() {
      return Promise.resolve({ since: state.cursor, sweep: state.sweep });
    },
    release(issue, stage, token) {
      const existing = table.get(key(issue, stage));
      if (existing?.status === "claimed" && existing.token === token) {
        table.set(key(issue, stage), {
          ...existing,
          retryAfter: Math.max(
            existing.retryAfter,
            state.now + backoffMs(existing.attempts - 1)
          ),
          status: "waiting",
          token: null,
        });
      }
      return Promise.resolve();
    },
    resolvePending(item, wait) {
      if (state.failNextResolve) {
        state.failNextResolve = false;
        return Promise.reject(new Error("database unavailable"));
      }
      if (!current(item)) {
        return Promise.resolve(false);
      }
      pending.delete(item.issue);
      const row = table.get(key(item.issue, "fixed"));
      if (row?.status === "waiting" && wait.kind === "drop") {
        table.delete(key(item.issue, "fixed"));
      }
      if (row?.status === "waiting" && wait.kind === "stamp") {
        table.set(key(item.issue, "fixed"), { ...row, checkedSha: wait.sha });
      }
      return Promise.resolve(true);
    },
    rows(issue) {
      return Promise.resolve(
        [...table.entries()]
          .filter(([k]) => k.startsWith(`${issue}|`))
          .map(([, row]) => row)
      );
    },
    saveCursor(ms) {
      state.cursor = Math.max(state.cursor ?? 0, ms);
      state.cursorWrites.push(ms);
      state.sweep = null;
      return Promise.resolve();
    },
    saveSweep(sweep) {
      state.sweep = sweep;
      return Promise.resolve();
    },
  };
  return { pending, state, store, table };
};

export interface FakeTicket {
  anchorId: string | null;
  facts: TicketFacts;
  foremanComments: { body: string; id: string }[];
  issueId: string;
  parentUpdatedAt: string | null;
  undeliverable: string[] | null;
  updatedAt: string;
}

export const ticket = (over: Partial<TicketFacts> = {}): FakeTicket => {
  const made = facts(over);
  return {
    anchorId: "anchor-1",
    facts: made,
    foremanComments: [],
    issueId: `uuid-${made.identifier}`,
    parentUpdatedAt: null,
    undeliverable: null,
    updatedAt: made.createdAt,
  };
};

export const fakeLinear = (tickets: FakeTicket[]) => {
  const posts: { body: string; id: string; identifier: string }[] = [];
  const state: {
    discoverFails: boolean;
    discoverPageSize: number;
    discoveries: {
      after: string | null;
      createdAfter: string;
      updatedSince: string;
    }[];
    failAfterCreate: boolean;
    failNextPost: boolean;
    /** Issues whose light original read fails. */
    failOriginals: Set<string>;
    holdNextPost: Promise<void> | null;
    longThreads: Set<string>;
    originalReads: number;
    reads: number;
  } = {
    discoverFails: false,
    discoveries: [],
    discoverPageSize: Number.POSITIVE_INFINITY,
    failAfterCreate: false,
    failNextPost: false,
    failOriginals: new Set<string>(),
    holdNextPost: null,
    longThreads: new Set<string>(),
    originalReads: 0,
    reads: 0,
  };
  const created = new Map<string, { anchorId: string }>();
  const port: LinearPort = {
    discover(updatedSince, createdAfter, after) {
      state.discoveries.push({ after, createdAfter, updatedSince });
      if (state.discoverFails) {
        return Promise.reject(new Error("Linear is unavailable"));
      }
      const since = Date.parse(updatedSince);
      const matching = tickets
        .filter(
          (entry) =>
            entry.anchorId !== null &&
            Date.parse(entry.facts.createdAt) > Date.parse(createdAfter) &&
            (Date.parse(entry.updatedAt) > since ||
              (entry.parentUpdatedAt !== null &&
                Date.parse(entry.parentUpdatedAt) > since))
        )
        .map((entry) => ({
          issue: entry.facts.identifier,
          version: Math.max(
            Date.parse(entry.updatedAt),
            entry.parentUpdatedAt ? Date.parse(entry.parentUpdatedAt) : 0
          ),
        }))
        .sort((a, b) => a.issue.localeCompare(b.issue));
      const start = after === null ? 0 : Number(after);
      const end = Math.min(matching.length, start + state.discoverPageSize);
      return Promise.resolve({
        next: end < matching.length ? String(end) : null,
        tickets: matching.slice(start, end),
      });
    },
    findComment(id) {
      const found = created.get(id);
      return Promise.resolve(found ? { parentId: found.anchorId } : null);
    },
    async postUnderAnchor(issueId, anchorId, body, id) {
      const hold = state.holdNextPost;
      state.holdNextPost = null;
      if (hold) {
        await hold;
      }
      if (state.failNextPost) {
        state.failNextPost = false;
        throw new Error("Linear is unavailable");
      }
      const target = tickets.find((entry) => entry.issueId === issueId);
      if (!target) {
        throw new Error("unknown issue");
      }
      if (created.has(id)) {
        throw new Error("comment id already exists");
      }
      created.set(id, { anchorId });
      target.foremanComments.push({ body, id });
      posts.push({ body, id, identifier: target.facts.identifier });
      if (state.failAfterCreate) {
        state.failAfterCreate = false;
        throw new Error("Linear timed out after creating the comment");
      }
      return id;
    },
    readOriginal(identifier) {
      state.originalReads += 1;
      if (state.failOriginals.has(identifier)) {
        return Promise.reject(new Error(`${identifier} read timed out`));
      }
      const found = tickets.find(
        (entry) => entry.facts.identifier === identifier
      );
      return Promise.resolve(found ? { ...found.facts } : null);
    },
    readTicket(identifier) {
      state.reads += 1;
      if (state.longThreads.has(identifier)) {
        return Promise.reject(new Error(`${identifier} thread is incomplete`));
      }
      const found = tickets.find(
        (entry) => entry.facts.identifier === identifier
      );
      return Promise.resolve(
        found
          ? ({
              ...found,
              foremanComments: [...found.foremanComments],
            } satisfies TicketView)
          : null
      );
    },
  };
  return { port, posts, state, tickets };
};

export const fakeDeploy = (initial: {
  ancestors?: Record<string, boolean>;
  liveSha: string | null;
  pulls: Record<string, PullFacts>;
}) => {
  const state = {
    ancestors: initial.ancestors ?? {},
    calls: { ancestor: 0, live: 0, pull: 0 },
    liveSha: initial.liveSha,
    pulls: initial.pulls,
  };
  const probe: DeployProbe = {
    isAncestor(_repo, base, head) {
      state.calls.ancestor += 1;
      return Promise.resolve(state.ancestors[`${base}>${head}`] === true);
    },
    liveSha() {
      state.calls.live += 1;
      return Promise.resolve(state.liveSha);
    },
    pull(repo, number) {
      state.calls.pull += 1;
      const found = state.pulls[`${repo}#${number}`];
      return found
        ? Promise.resolve(found)
        : Promise.reject(new Error("unknown pull"));
    },
  };
  return { probe, state };
};

export const depsOf = (
  linear: LinearPort,
  deploy: DeployProbe,
  store: ReporterStore,
  over: Partial<RunConfig> = {},
  write: ReporterWriter = fakeWriter().write
): Deps => ({ config: config(over), deploy, linear, store, write });

export const waitingIssues = (memory: ReturnType<typeof memoryStore>) =>
  [...memory.table.entries()]
    .filter(([k, row]) => k.endsWith("|fixed") && row.status === "waiting")
    .map(([k, row]) => ({
      checkedSha: row.checkedSha,
      issue: k.split("|")[0],
    }));

export const setup = (
  tickets = [ticket()],
  deploy: Parameters<typeof fakeDeploy>[0] = { liveSha: OLD_SHA, pulls: {} },
  over: Partial<RunConfig> = {}
) => {
  const linear = fakeLinear(tickets);
  const probe = fakeDeploy(deploy);
  const memory = memoryStore();
  const writer = fakeWriter();
  const deps = depsOf(
    linear.port,
    probe.probe,
    memory.store,
    over,
    writer.write
  );
  return { deps, linear, memory, probe, writer };
};

export const reconcile = (s: ReturnType<typeof setup>, identifier = "ENG-1") =>
  reconcileTicket(identifier, s.deps, () => s.probe.probe.liveSha());
