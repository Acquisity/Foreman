import type { Stage } from "./copy.js";
import type { DeployProbe } from "./deploy.js";
import type { LinearPort, TicketView } from "./linear.js";
import type { PullFacts, TicketFacts } from "./plan.js";
import type { Deps, RunConfig } from "./run.js";
import { type LedgerRow, MAX_ATTEMPTS, type ReporterStore } from "./store.js";

export const SANDBOX = "C0AAAAAAAAA";
export const FOREMAN = "foreman-user";
export const OLD_SHA = "1111111111111111111111111111111111111111";
export const NEW_SHA = "2222222222222222222222222222222222222222";
export const MERGE_SHA = "3333333333333333333333333333333333333333";

export const config = (over: Partial<RunConfig> = {}): RunConfig => ({
  channels: new Set([SANDBOX]),
  lookbackMs: 3_600_000,
  maxPosts: 20,
  nameOwner: true,
  runDeadlineMs: 240_000,
  since: "2026-10-01T00:00:00.000Z",
  ...over,
});

export const facts = (over: Partial<TicketFacts> = {}): TicketFacts => ({
  assignee: "Sam Jones",
  channel: SANDBOX,
  createdAt: "2026-10-10T10:00:00.000Z",
  identifier: "ENG-1",
  labels: [],
  parent: null,
  pullUrls: [],
  stateName: "Todo",
  stateType: "unstarted",
  ...over,
});

interface StoredRow extends LedgerRow {
  attempts: number;
  claimedAt: number;
  message: string;
  token: string | null;
}

export const memoryStore = () => {
  const table = new Map<string, StoredRow>();
  const key = (issue: string, stage: Stage) => `${issue}|${stage}`;
  const state: { failNextMarkSent: boolean; now: number; tokens: number } = {
    failNextMarkSent: false,
    now: 0,
    tokens: 0,
  };
  const blank = (stage: Stage): StoredRow => ({
    attempts: 0,
    checkedSha: null,
    claimedAt: 0,
    commentId: null,
    message: "",
    stage,
    status: "waiting",
    token: null,
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
    claim(issue, stage, message) {
      const existing = table.get(key(issue, stage));
      const stale =
        existing?.status === "claimed" &&
        state.now - existing.claimedAt > 600_000;
      if (existing?.status === "sent") {
        return Promise.resolve({ ok: false, reason: "busy" });
      }
      if (existing && existing.attempts >= MAX_ATTEMPTS) {
        return Promise.resolve({ ok: false, reason: "exhausted" });
      }
      if (existing && existing.status !== "waiting" && !stale) {
        return Promise.resolve({ ok: false, reason: "busy" });
      }
      state.tokens += 1;
      const token = `token-${state.tokens}`;
      table.set(key(issue, stage), {
        ...(existing ?? blank(stage)),
        attempts: (existing?.attempts ?? 0) + 1,
        claimedAt: state.now,
        message,
        status: "claimed",
        token,
      });
      return Promise.resolve({ ok: true, token });
    },
    async complete(issue, stage, covers, message, channel, commentId, token) {
      const existing = table.get(key(issue, stage));
      if (existing?.token !== token || existing.status !== "claimed") {
        return false;
      }
      await markSent(issue, covers, message, channel, commentId);
      return true;
    },
    listWaiting() {
      return Promise.resolve(
        [...table.entries()]
          .filter(
            ([k, row]) => k.endsWith("|fixed") && row.status === "waiting"
          )
          .map(([k, row]) => ({
            checkedSha: row.checkedSha,
            issue: k.split("|")[0] ?? "",
          }))
      );
    },
    markSent,
    markWaiting(issue, checkedSha) {
      const existing = table.get(key(issue, "fixed"));
      if (!existing || existing.status === "waiting") {
        table.set(key(issue, "fixed"), {
          ...(existing ?? blank("fixed")),
          checkedSha,
          status: "waiting",
        });
      }
      return Promise.resolve();
    },
    release(issue, stage, token) {
      const existing = table.get(key(issue, stage));
      if (existing?.status === "claimed" && existing.token === token) {
        table.set(key(issue, stage), {
          ...existing,
          status: "waiting",
          token: null,
        });
      }
      return Promise.resolve();
    },
    rows(issue) {
      return Promise.resolve(
        [...table.entries()]
          .filter(([k]) => k.startsWith(`${issue}|`))
          .map(([, row]) => row)
      );
    },
  };
  return { state, store, table };
};

export interface FakeTicket {
  anchorId: string | null;
  facts: TicketFacts;
  foremanComments: { body: string; id: string }[];
  issueId: string;
}

export const ticket = (over: Partial<TicketFacts> = {}): FakeTicket => {
  const made = facts(over);
  return {
    anchorId: "anchor-1",
    facts: made,
    foremanComments: [],
    issueId: `uuid-${made.identifier}`,
  };
};

export const fakeLinear = (tickets: FakeTicket[]) => {
  const posts: { body: string; id: string; identifier: string }[] = [];
  const state: {
    failAfterCreate: boolean;
    failNextPost: boolean;
    holdNextPost: Promise<void> | null;
    reads: number;
  } = {
    failAfterCreate: false,
    failNextPost: false,
    holdNextPost: null,
    reads: 0,
  };
  const created = new Map<string, { anchorId: string }>();
  const port: LinearPort = {
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
    readTicket(identifier) {
      state.reads += 1;
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
    recentIdentifiers() {
      return Promise.resolve(tickets.map((entry) => entry.facts.identifier));
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
  over: Partial<RunConfig> = {}
): Deps => ({ config: config(over), deploy, linear, store });
