import type { Stage } from "./copy.js";
import type { DeployProbe } from "./deploy.js";
import type { LinearPort, TicketView } from "./linear.js";
import type { PullFacts, TicketFacts } from "./plan.js";
import type { Deps, RunConfig } from "./run.js";
import type { LedgerRow, ReporterStore } from "./store.js";

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
  claimedAt: number;
  message: string;
}

export const memoryStore = () => {
  const table = new Map<string, StoredRow>();
  const key = (issue: string, stage: Stage) => `${issue}|${stage}`;
  const state: { failNextMarkSent: boolean; now: number } = {
    failNextMarkSent: false,
    now: 0,
  };
  const store: ReporterStore = {
    claim(issue, stage, message) {
      const existing = table.get(key(issue, stage));
      const stale =
        existing?.status === "claimed" &&
        state.now - existing.claimedAt > 600_000;
      if (existing && existing.status !== "waiting" && !stale) {
        return Promise.resolve(false);
      }
      table.set(key(issue, stage), {
        checkedSha: existing?.checkedSha ?? null,
        claimedAt: state.now,
        commentId: null,
        message,
        stage,
        status: "claimed",
      });
      return Promise.resolve(true);
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
    markSent(issue, stages, message, _channel, commentId) {
      if (state.failNextMarkSent) {
        state.failNextMarkSent = false;
        return Promise.reject(new Error("database unavailable"));
      }
      for (const stage of stages) {
        table.set(key(issue, stage), {
          checkedSha: null,
          claimedAt: state.now,
          commentId,
          message,
          stage,
          status: "sent",
        });
      }
      return Promise.resolve();
    },
    markWaiting(issue, checkedSha) {
      const existing = table.get(key(issue, "fixed"));
      if (!existing || existing.status === "waiting") {
        table.set(key(issue, "fixed"), {
          checkedSha,
          claimedAt: 0,
          commentId: null,
          message: "",
          stage: "fixed",
          status: "waiting",
        });
      }
      return Promise.resolve();
    },
    release(issue, stage) {
      const existing = table.get(key(issue, stage));
      if (existing?.status === "claimed") {
        table.set(key(issue, stage), { ...existing, status: "waiting" });
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
  const posts: { body: string; identifier: string }[] = [];
  const state: { failNextPost: boolean; reads: number } = {
    failNextPost: false,
    reads: 0,
  };
  const port: LinearPort = {
    postUnderAnchor(issueId, _anchorId, body) {
      if (state.failNextPost) {
        state.failNextPost = false;
        return Promise.reject(new Error("Linear is unavailable"));
      }
      const target = tickets.find((entry) => entry.issueId === issueId);
      if (!target) {
        return Promise.reject(new Error("unknown issue"));
      }
      const id = `comment-${posts.length + 1}`;
      target.foremanComments.push({ body, id });
      posts.push({ body, identifier: target.facts.identifier });
      return Promise.resolve(id);
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
