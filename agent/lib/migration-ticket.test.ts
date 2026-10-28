import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import type { SessionAuthContext } from "eve/context";
import {
  COMPILE_METADATA_PATH,
  COMPILED_MANIFEST_PATH,
  readCompiledManifest,
} from "./capability-budget.js";
import {
  cancelMigrationTicket,
  createMigrationTicket,
  FOREMAN_LINEAR_AGENT,
  invokeProvider,
  MIGRATION_TICKET_OWNER,
} from "./executor/dispatch.js";
import { ExecutorError, executorTransport } from "./executor/transport.js";
import { isTriageIntakeAsk } from "./linear-context.js";
import {
  type Candidate,
  fileMigrationTicket,
  MAX_CANDIDATES,
  type MigrationTicketDeps,
  type MigrationTicketInput,
  readCandidates,
} from "./migration-ticket.js";
import {
  filingScope,
  migrationFiledReport,
  migrationScopeBlock,
  migrationTicketScope,
  slackThreadPermalink,
} from "./migration-ticket-scope.js";
import { readAskFrom } from "./requester-reply.js";
import { slackSessionAuth } from "./session-auth.js";
import { QUESTIONS_ONLY_WORKSPACES } from "./slack-intake.js";

const MIGRATION = "C0BQM9V6P47";
const SANDBOX = "C0C6DM2MB39";
const APP_PUBLISHING = "C0C8XP8HAFL";
const THREAD = "1789231558.984729";
const AIA = QUESTIONS_ONLY_WORKSPACES[MIGRATION]?.id ?? "";
const OTHER_ORG = "00000000-0000-4000-8000-000000000001";
const RECORD = "11111111-1111-4111-8111-111111111111";

const REPORTER_AS_CUSTOMER = /#### Customer Email\n\nrep@example\.com/u;
const TEAMMATE_AS_CUSTOMER = /#### Customer Email\n\nteammate@example\.com/u;
const REPORTER_EMAIL = /rep@example\.com/u;
const RESOLVED_RECORD = /#### Which lead\?\n\nPat Lead \(contact 11111111/u;
const PINNED_WORKSPACE_ID = /#### Workspace ID\n\n1cfacf97-/u;
const IMPACT_LINE = /Who it hurts: The rep cannot text any lead/u;
const WORKAROUND_LINE =
  /Workaround given: Send the text from the person's record page\./u;
const FORM_HEADINGS = [
  "Customer Email",
  "Workspace name",
  "Workspace ID",
  "Which lead?",
  "What's wrong?",
  "Screenshot",
  "Video link",
];

const slackAuth = (
  channel: string,
  user = "U0REP",
  thread = THREAD
): SessionAuthContext =>
  slackSessionAuth(
    {
      attributes: {
        author_type: "user",
        channel_id: channel,
        thread_ts: thread,
        user_id: user,
      },
      authenticator: "slack-webhook",
      principalId: `slack:T1:${user}`,
      principalType: "user",
    },
    { intakeOnly: true, questionsOnly: true }
  );

const ctxFor = (
  current: SessionAuthContext,
  initiator: SessionAuthContext = current,
  parent?: { sessionId: string }
) =>
  ({
    abortSignal: AbortSignal.timeout(2000),
    getToken: async () => ({ token: "test-token" }),
    session: { auth: { current, initiator }, ...(parent ? { parent } : {}) },
  }) as never;

const complete: MigrationTicketInput = {
  affectedUser: "reporter",
  checked:
    "Read the Conversations code and this rep's sent messages for today.",
  classification: "bug",
  expected: "The text sends to the lead.",
  happened: "The composer shows 'message failed' and nothing is sent.",
  impact: "The rep cannot text any lead, so follow-ups are stalled.",
  searchPhrases: ["text message failed", "conversations composer send"],
  title: "Texts from Conversations fail with 'message failed'",
  tried: "Sent a text to a lead from the Conversations tab.",
  visual: false,
  when: "28 Oct 2026, about 3 pm Dubai",
  where: "Conversations, Needs reply tab",
};

interface StoredTicket {
  createdAt: string;
  identifier: string;
  stateType: string;
  url: string;
}

interface Recorder {
  cancelled: string[];
  created: {
    description: string;
    link: { title: string; url: string };
    title: string;
  }[];
  deps: MigrationTicketDeps;
  lookups: string[];
  searches: string[][];
  store: StoredTicket[];
  synced: { issue: string; title?: string; url: string }[];
}

const urlOf = (identifier: string) =>
  `https://linear.app/acquisity/issue/${identifier}/texts-fail`;

/** A fake Linear: tickets live in one store every dependency reads and writes. */
const recorder = (
  options: {
    existing?: Omit<StoredTicket, "createdAt">[];
    memberOf?: Record<string, string[]>;
    records?: Record<string, string>;
    related?: Candidate[];
    relatedTruncated?: boolean;
    reporter?: string | null;
    synced?: Record<string, boolean | null>;
  } = {}
): Recorder => {
  let next = 20_001;
  const rec: Recorder = {
    cancelled: [],
    created: [],
    deps: {} as MigrationTicketDeps,
    lookups: [],
    searches: [],
    store: (options.existing ?? []).map((ticket, index) => ({
      ...ticket,
      createdAt: `2026-10-27T00:00:0${index}Z`,
    })),
    synced: [],
  };
  rec.deps = {
    cancel: (_ctx, identifier) => {
      rec.cancelled.push(identifier);
      const ticket = rec.store.find((item) => item.identifier === identifier);
      if (ticket) {
        ticket.stateType = "canceled";
      }
      return Promise.resolve({ data: {}, ok: true } as never);
    },
    create: async (_ctx, input) => {
      rec.created.push(input);
      const identifier = `ENG-${next}`;
      next += 1;
      // Yield first, so two racing filers both read before either writes.
      await Promise.resolve();
      rec.store.push({
        createdAt: `2026-10-28T10:00:${String(next).slice(-2)}Z`,
        identifier,
        stateType: "triage",
        url: urlOf(identifier),
      });
      return {
        data: { id: identifier, url: urlOf(identifier) },
        ok: true,
      } as never;
    },
    lookupMemberships: (email) => {
      rec.lookups.push(email);
      const orgs = options.memberOf?.[email];
      return Promise.resolve(
        orgs === undefined ? { found: false, orgs: [] } : { found: true, orgs }
      );
    },
    readRecord: (_ctx, record, organizationId) =>
      Promise.resolve(
        organizationId === AIA ? (options.records?.[record.id] ?? null) : null
      ),
    related: () =>
      Promise.resolve({
        issues: options.related ?? [],
        truncated: options.relatedTruncated ?? false,
      }),
    requester: () =>
      Promise.resolve(
        options.reporter === null
          ? { status: "unknown" as const }
          : {
              email: options.reporter ?? "rep@example.com",
              status: "known" as const,
            }
      ),
    synced: (_ctx, issue) =>
      Promise.resolve(
        options.synced && issue in options.synced
          ? (options.synced[issue] ?? null)
          : true
      ),
    syncSlack: (_ctx, issue, link) => {
      rec.synced.push({ issue, ...link });
      return Promise.resolve(true);
    },
    thread: (key) => {
      rec.searches.push([key]);
      return Promise.resolve(rec.store.map((ticket) => ({ ...ticket })));
    },
  };
  return rec;
};

const candidate = (identifier: string): Candidate => ({
  excerpt: "Texts sent from Conversations fail with message failed.",
  identifier,
  state: "In Progress",
  title: "Texts fail from Conversations",
  url: urlOf(identifier),
});

const member = { "rep@example.com": [AIA] };

describe("file_migration_ticket refusals", () => {
  it("names every missing required field and files nothing", async () => {
    const rec = recorder({ memberOf: member });
    const result = await fileMigrationTicket(
      ctxFor(slackAuth(MIGRATION)),
      { title: "Something broke" },
      rec.deps
    );
    assert.ok("missing" in result);
    assert.deepEqual(
      [...result.missing].sort(),
      [
        "affectedUser",
        "checked",
        "classification",
        "expected",
        "happened",
        "impact",
        "searchPhrases",
        "tried",
        "visual",
        "when",
        "where",
      ].sort()
    );
    assert.equal(rec.created.length, 0);
    // Only the thread's own ticket was looked for; nothing was searched or filed.
    assert.deepEqual(rec.searches, [[`${MIGRATION}/${THREAD}`]]);
  });

  it("asks for a screenshot or video when the problem is visual", async () => {
    const rec = recorder({ memberOf: member });
    const result = await fileMigrationTicket(
      ctxFor(slackAuth(MIGRATION)),
      { ...complete, visual: true },
      rec.deps
    );
    assert.ok("missing" in result);
    assert.deepEqual(result.missing, ["screenshot"]);
    assert.equal(rec.created.length, 0);
  });

  it("needs the workaround it gave when the outcome is a workaround", async () => {
    const rec = recorder({ memberOf: member });
    const result = await fileMigrationTicket(
      ctxFor(slackAuth(MIGRATION)),
      { ...complete, classification: "workaround" },
      rec.deps
    );
    assert.ok("missing" in result);
    assert.deepEqual(result.missing, ["workaroundGiven"]);
  });

  it("refuses when the requester's Slack identity cannot be read", async () => {
    const rec = recorder({ memberOf: member, reporter: null });
    const result = await fileMigrationTicket(
      ctxFor(slackAuth(MIGRATION)),
      complete,
      rec.deps
    );
    assert.ok("error" in result);
    assert.equal(rec.created.length, 0);
  });
});

describe("file_migration_ticket affected user", () => {
  it("uses the reporter's Slack email only when the report is about them", async () => {
    const rec = recorder({ memberOf: member });
    const result = await fileMigrationTicket(
      ctxFor(slackAuth(MIGRATION)),
      complete,
      rec.deps
    );
    assert.ok("identifier" in result);
    const description = String(rec.created[0]?.description);
    assert.match(description, REPORTER_AS_CUSTOMER);
  });

  it("never uses the reporter's email for a report made for someone else", async () => {
    const rec = recorder({
      memberOf: { ...member, "teammate@example.com": [AIA] },
    });
    const result = await fileMigrationTicket(
      ctxFor(slackAuth(MIGRATION)),
      { ...complete, affectedUser: "teammate@example.com" },
      rec.deps
    );
    assert.ok("identifier" in result);
    const description = String(rec.created[0]?.description);
    assert.match(description, TEAMMATE_AS_CUSTOMER);
    assert.doesNotMatch(
      description.split("## Filed from Slack")[0] ?? "",
      REPORTER_EMAIL
    );
    assert.deepEqual(rec.lookups, ["teammate@example.com"]);
  });

  it("refuses an affected user who is not in the pinned workspace", async () => {
    const rec = recorder({
      memberOf: { ...member, "outsider@example.com": [OTHER_ORG] },
    });
    for (const affectedUser of ["outsider@example.com", "nobody@example.com"]) {
      // biome-ignore lint/performance/noAwaitInLoops: two cases, read in order.
      const result = await fileMigrationTicket(
        ctxFor(slackAuth(MIGRATION)),
        { ...complete, affectedUser },
        rec.deps
      );
      assert.ok("missing" in result);
      assert.deepEqual(result.missing, ["affectedUser"]);
    }
    assert.equal(rec.created.length, 0);
  });

  it("refuses a reporter who is not a member of the pinned workspace", async () => {
    const rec = recorder({ memberOf: { "rep@example.com": [OTHER_ORG] } });
    const result = await fileMigrationTicket(
      ctxFor(slackAuth(MIGRATION)),
      complete,
      rec.deps
    );
    assert.ok("missing" in result);
    assert.deepEqual(result.missing, ["affectedUser"]);
  });

  it("uses a named record only when it resolves inside the pinned workspace", async () => {
    const found = recorder({
      memberOf: member,
      records: { [RECORD]: "Pat Lead" },
    });
    const ok = await fileMigrationTicket(
      ctxFor(slackAuth(MIGRATION)),
      { ...complete, record: { id: RECORD, type: "contact" } },
      found.deps
    );
    assert.ok("identifier" in ok);
    assert.match(String(found.created[0]?.description), RESOLVED_RECORD);
    const missing = recorder({ memberOf: member });
    const refused = await fileMigrationTicket(
      ctxFor(slackAuth(MIGRATION)),
      {
        ...complete,
        record: { id: "22222222-2222-4222-8222-222222222222", type: "deal" },
      },
      missing.deps
    );
    assert.ok("missing" in refused);
    assert.deepEqual(refused.missing, ["record"]);
    assert.equal(missing.created.length, 0);
  });
});

describe("file_migration_ticket filing", () => {
  it("files a form-shaped ticket linked to the thread", async () => {
    const rec = recorder({ memberOf: member });
    const result = await fileMigrationTicket(
      ctxFor(slackAuth(MIGRATION)),
      {
        ...complete,
        classification: "workaround",
        workaroundGiven: "Send the text from the person's record page.",
      },
      rec.deps
    );
    assert.deepEqual(result, {
      existing: false,
      identifier: "ENG-20001",
      threadSynced: true,
      url: urlOf("ENG-20001"),
    });
    const [input] = rec.created;
    const permalink = slackThreadPermalink(MIGRATION, THREAD);
    assert.equal(
      permalink,
      "https://acquisityworkspace.slack.com/archives/C0BQM9V6P47/p1789231558984729"
    );
    assert.deepEqual(input?.link, {
      title: "Ask from rep@example.com",
      url: permalink,
    });
    // The same check the Linear channel runs before a triage session starts.
    assert.equal(isTriageIntakeAsk(input ? [input.link] : []), true);
    const description = String(input?.description);
    for (const heading of FORM_HEADINGS) {
      assert.ok(description.includes(`#### ${heading}\n`), heading);
    }
    assert.match(description, PINNED_WORKSPACE_ID);
    assert.match(description, IMPACT_LINE);
    assert.match(description, WORKAROUND_LINE);
    assert.ok(
      description.endsWith(
        migrationScopeBlock(
          migrationTicketScope(slackAuth(MIGRATION)) ?? assert.fail(),
          "rep@example.com"
        )
      )
    );
    assert.deepEqual(rec.synced, [
      { issue: "ENG-20001", title: "Ask from rep@example.com", url: permalink },
    ]);
  });

  it("returns the thread's existing ticket instead of filing a second", async () => {
    const rec = recorder({
      existing: [
        {
          identifier: "ENG-19999",
          stateType: "triage",
          url: urlOf("ENG-19999"),
        },
      ],
      memberOf: member,
    });
    const result = await fileMigrationTicket(
      ctxFor(slackAuth(MIGRATION)),
      complete,
      rec.deps
    );
    assert.deepEqual(result, {
      existing: true,
      identifier: "ENG-19999",
      threadSynced: true,
      url: urlOf("ENG-19999"),
    });
    assert.deepEqual(rec.searches, [[`${MIGRATION}/${THREAD}`]]);
    assert.equal(rec.created.length, 0);
  });

  it("C3: a completed ticket still covers the thread; only a canceled one does not", async () => {
    const done = recorder({
      existing: [
        {
          identifier: "ENG-19999",
          stateType: "completed",
          url: urlOf("ENG-19999"),
        },
      ],
      memberOf: member,
    });
    const doneResult = await fileMigrationTicket(
      ctxFor(slackAuth(MIGRATION)),
      complete,
      done.deps
    );
    assert.ok("identifier" in doneResult && doneResult.existing === true);
    assert.equal(doneResult.identifier, "ENG-19999");
    assert.equal(done.created.length, 0);
    const canceled = recorder({
      existing: [
        {
          identifier: "ENG-19999",
          stateType: "canceled",
          url: urlOf("ENG-19999"),
        },
      ],
      memberOf: member,
    });
    const canceledResult = await fileMigrationTicket(
      ctxFor(slackAuth(MIGRATION)),
      complete,
      canceled.deps
    );
    assert.ok(
      "identifier" in canceledResult && canceledResult.existing === false
    );
    assert.equal(canceled.created.length, 1);
  });

  it("keeps the ticket when the Slack thread sync fails", async () => {
    const rec = recorder({ memberOf: member });
    rec.deps.syncSlack = () => Promise.resolve(false);
    const result = await fileMigrationTicket(
      ctxFor(slackAuth(SANDBOX)),
      complete,
      rec.deps
    );
    assert.ok("identifier" in result);
    assert.equal(result.existing, false);
    assert.equal(result.threadSynced, false);
  });

  it("C4: a later call repairs an unsynced thread and always reports threadSynced", async () => {
    const existing = [
      { identifier: "ENG-19999", stateType: "triage", url: urlOf("ENG-19999") },
    ];
    const unsynced = recorder({
      existing,
      memberOf: member,
      synced: { "ENG-19999": false },
    });
    const repaired = await fileMigrationTicket(
      ctxFor(slackAuth(MIGRATION)),
      complete,
      unsynced.deps
    );
    assert.deepEqual(repaired, {
      existing: true,
      identifier: "ENG-19999",
      threadSynced: true,
      url: urlOf("ENG-19999"),
    });
    // The repair passes no title, so the reporter's 'Ask from' title stays.
    assert.deepEqual(unsynced.synced, [
      { issue: "ENG-19999", url: slackThreadPermalink(MIGRATION, THREAD) },
    ]);
    const alreadySynced = recorder({ existing, memberOf: member });
    const kept = await fileMigrationTicket(
      ctxFor(slackAuth(MIGRATION)),
      complete,
      alreadySynced.deps
    );
    assert.ok("threadSynced" in kept && kept.threadSynced === true);
    assert.equal(alreadySynced.synced.length, 0);
    // When the anchor cannot be read, nothing is re-linked blindly.
    const unreadable = recorder({
      existing,
      memberOf: member,
      synced: { "ENG-19999": null },
    });
    const unknown = await fileMigrationTicket(
      ctxFor(slackAuth(MIGRATION)),
      complete,
      unreadable.deps
    );
    assert.ok("threadSynced" in unknown && unknown.threadSynced === false);
    assert.equal(unreadable.synced.length, 0);
  });

  it("C1: two concurrent filings in one thread leave exactly one live ticket", async () => {
    const rec = recorder({ memberOf: member });
    const ctx = ctxFor(slackAuth(MIGRATION));
    const [first, second] = await Promise.all([
      fileMigrationTicket(ctx, complete, rec.deps),
      fileMigrationTicket(ctx, complete, rec.deps),
    ]);
    assert.equal(rec.created.length, 2);
    const live = rec.store.filter((ticket) => ticket.stateType !== "canceled");
    assert.deepEqual(
      live.map((ticket) => ticket.identifier),
      ["ENG-20001"]
    );
    assert.deepEqual(rec.cancelled, ["ENG-20002"]);
    for (const result of [first, second]) {
      assert.ok("identifier" in result);
      assert.equal(result.identifier, "ENG-20001");
    }
  });
});

describe("file_migration_ticket related tickets", () => {
  it("C2: lists open candidates with their state and a description excerpt", async () => {
    const rec = recorder({
      memberOf: member,
      related: [candidate("ENG-15156")],
    });
    const result = await fileMigrationTicket(
      ctxFor(slackAuth(MIGRATION)),
      complete,
      rec.deps
    );
    assert.ok("candidates" in result);
    assert.deepEqual(result.candidates, [candidate("ENG-15156")]);
    assert.equal(result.truncated, false);
    assert.equal(rec.created.length, 0);
  });

  it("C2: reads candidates once, open ones only, with a bounded excerpt", async () => {
    const requests: unknown[] = [];
    const long = "x".repeat(2000);
    const { issues, truncated } = await readCandidates(
      ["text message failed", "composer send"],
      {
        client: (request) => {
          requests.push(request);
          return Promise.resolve({
            data: {
              data: {
                issues: {
                  nodes: [
                    {
                      comments: { nodes: [] },
                      createdAt: "2026-10-20T00:00:00Z",
                      description: long,
                      identifier: "ENG-15156",
                      state: { name: "In Progress" },
                      title: "Texts fail",
                      url: urlOf("ENG-15156"),
                    },
                  ],
                },
              },
            },
            status: 200,
          });
        },
      }
    );
    assert.equal(requests.length, 1);
    const sent = requests[0] as {
      input: { variables: { filter: { and: unknown[] } } };
      operation: string;
    };
    assert.equal(sent.operation, "linear.IssueBodies");
    assert.deepEqual(sent.input.variables.filter.and[1], {
      state: { type: { nin: ["canceled", "completed"] } },
    });
    assert.equal(issues[0]?.state, "In Progress");
    assert.equal(issues[0]?.excerpt.length, 603);
    assert.equal(truncated, false);
  });

  it("files once the model acknowledges exactly the candidates shown", async () => {
    const rec = recorder({
      memberOf: member,
      related: [candidate("ENG-15156")],
    });
    const result = await fileMigrationTicket(
      ctxFor(slackAuth(MIGRATION)),
      { ...complete, reviewedCandidates: ["ENG-15156"] },
      rec.deps
    );
    assert.ok("identifier" in result && result.existing === false);
  });

  it("T3: shows at most 20, needs exactly those acknowledged, and says when more matched", async () => {
    const many = Array.from({ length: 21 }, (_, index) =>
      candidate(`ENG-${15_000 + index}`)
    );
    const rec = recorder({ memberOf: member, related: many });
    const first = await fileMigrationTicket(
      ctxFor(slackAuth(MIGRATION)),
      complete,
      rec.deps
    );
    assert.ok("candidates" in first);
    assert.equal(first.candidates.length, MAX_CANDIDATES);
    assert.equal(first.truncated, true);
    const shown = first.candidates.map((item) => item.identifier);
    // Acknowledging fewer than shown does not file.
    const partial = await fileMigrationTicket(
      ctxFor(slackAuth(MIGRATION)),
      { ...complete, reviewedCandidates: shown.slice(1) },
      rec.deps
    );
    assert.ok("candidates" in partial);
    const filed = await fileMigrationTicket(
      ctxFor(slackAuth(MIGRATION)),
      { ...complete, reviewedCandidates: shown },
      rec.deps
    );
    assert.ok("identifier" in filed && filed.existing === false);
    assert.equal(rec.created.length, 1);
  });

  it("T3: carries the read's own truncation through", async () => {
    const rec = recorder({
      memberOf: member,
      related: [candidate("ENG-15156")],
      relatedTruncated: true,
    });
    const result = await fileMigrationTicket(
      ctxFor(slackAuth(MIGRATION)),
      complete,
      rec.deps
    );
    assert.ok("candidates" in result && result.truncated === true);
  });
});

describe("file_migration_ticket channel gating", () => {
  it("is scoped to the migration channel and its sandbox only", () => {
    assert.ok(migrationTicketScope(slackAuth(MIGRATION)));
    assert.ok(migrationTicketScope(slackAuth(SANDBOX)));
    // App Publishing stays questions-only with no ticket filing.
    assert.equal(migrationTicketScope(slackAuth(APP_PUBLISHING)), null);
    const ordinary = slackSessionAuth(
      {
        attributes: { channel_id: MIGRATION, thread_ts: THREAD, user_id: "U1" },
        authenticator: "slack-webhook",
        principalId: "slack:T1:U1",
        principalType: "user",
      },
      { intakeOnly: false }
    );
    // A session that is not questions-only never files from here either.
    assert.equal(migrationTicketScope(ordinary), null);
  });

  it("refuses a delegated or cross-thread caller", async () => {
    const rec = recorder({ memberOf: member });
    const child: SessionAuthContext = {
      attributes: {},
      authenticator: "eve",
      principalId: "agent",
      principalType: "service",
    };
    const otherThread = slackAuth(MIGRATION, "U0REP", "1789231999.000001");
    for (const current of [child, otherThread]) {
      // biome-ignore lint/performance/noAwaitInLoops: two cases, read in order.
      const result = await fileMigrationTicket(
        ctxFor(current, slackAuth(MIGRATION)),
        complete,
        rec.deps
      );
      assert.ok("error" in result);
    }
    const appPublishing = await fileMigrationTicket(
      ctxFor(slackAuth(APP_PUBLISHING)),
      complete,
      rec.deps
    );
    assert.ok("error" in appPublishing);
    assert.equal(rec.created.length, 0);
  });

  it("C1: refuses a delegated child that inherited the rep's Slack auth", async () => {
    const rec = recorder({ memberOf: member });
    const auth = slackAuth(MIGRATION);
    const child = ctxFor(auth, auth, { sessionId: "parent-session" });
    assert.equal(
      filingScope({
        auth: { current: auth, initiator: auth },
        parent: { sessionId: "parent-session" },
      }),
      null
    );
    const result = await fileMigrationTicket(child, complete, rec.deps);
    assert.ok("error" in result);
    assert.equal(rec.created.length, 0);
    // The Executor gate refuses the child's write too, before dispatch.
    await assert.rejects(
      createMigrationTicket(child, {
        description: `x\n\n${migrationScopeBlock(migrationTicketScope(auth) ?? assert.fail(), "rep@example.com")}`,
        link: {
          title: "Ask from rep@example.com",
          url: slackThreadPermalink(MIGRATION, THREAD),
        },
        title: "Forged",
      }),
      (error: unknown) =>
        error instanceof ExecutorError && error.code === "questions_only"
    );
  });

  it("refuses a hand-built Linear ticket write from a questions-only session before dispatch", async () => {
    const ctx = ctxFor(slackAuth(MIGRATION));
    await assert.rejects(
      invokeProvider(ctx, "linear.org.workspaceLinear.save_issue", {
        description: "anything",
        state: "Todo",
        team: "Engineering Team",
        title: "Forged",
      }),
      (error: unknown) =>
        error instanceof ExecutorError &&
        error.code === "questions_only" &&
        error.dispatched === false
    );
    // An update to an existing issue is refused the same way.
    await assert.rejects(
      invokeProvider(ctx, "linear.org.workspaceLinear.save_issue", {
        id: "ENG-1",
        state: "Done",
      }),
      (error: unknown) =>
        error instanceof ExecutorError && error.code === "questions_only"
    );
    // App Publishing's questions-only session cannot file at all.
    await assert.rejects(
      invokeProvider(
        ctxFor(slackAuth(APP_PUBLISHING)),
        "linear.org.workspaceLinear.save_comment",
        { body: "x", issueId: "ENG-1" }
      ),
      (error: unknown) =>
        error instanceof ExecutorError && error.code === "questions_only"
    );
  });
});

describe("a filed ticket reaches Foreman's triage", () => {
  const readsBack = (description: string, attachments: unknown[] = []) => ({
    fetch: (async () =>
      Response.json({
        data: { issue: { attachments: { nodes: attachments }, description } },
      })) as typeof fetch,
  });
  const scope = migrationTicketScope(slackAuth(MIGRATION)) ?? assert.fail();
  const filed = `#### What's wrong?\n\nTexts fail.\n\n${migrationScopeBlock(scope, "rep@example.com")}`;

  it("runs on the triage models with the reporter named before the attachment exists", async () => {
    const ask = await readAskFrom(
      "ENG-20001",
      { accessToken: "token" },
      readsBack(filed)
    );
    assert.deepEqual(ask, { requester: "rep@example.com", triageIntake: true });
  });

  it("does not trust a scope block that is not at the very end", async () => {
    const ask = await readAskFrom(
      "ENG-20001",
      { accessToken: "token" },
      readsBack(`${filed}\n\nAnd more text after it.`)
    );
    assert.deepEqual(ask, { requester: null, triageIntake: false });
    assert.equal(
      migrationFiledReport(filed.replace(MIGRATION, APP_PUBLISHING)),
      null
    );
  });
});

describe("the real ticket write passes the questions-only gate", () => {
  it("dispatches the shared-contract ticket, and only for its own thread", async () => {
    const original = executorTransport.call;
    const calls: unknown[][] = [];
    executorTransport.call = ((...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({
        data: { id: "ENG-20001", url: urlOf("ENG-20001") },
        ok: true,
      });
    }) as typeof executorTransport.call;
    try {
      const rec = recorder({ memberOf: member });
      const { cancel: _cancel, create: _create, ...deps } = rec.deps;
      const ctx = ctxFor(slackAuth(MIGRATION));
      const result = await fileMigrationTicket(ctx, complete, deps);
      assert.ok("identifier" in result && result.existing === false);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.[1], "linear.org.workspaceLinear.save_issue");
      const sent = calls[0]?.[2] as Record<string, unknown>;
      assert.equal(sent.team, "Engineering Team");
      assert.equal(sent.state, "Triage");
      assert.equal(sent.assignee, MIGRATION_TICKET_OWNER.assignee);
      assert.equal(sent.delegate, FOREMAN_LINEAR_AGENT);
      assert.equal("labels" in sent, false);
      const [link] = sent.links as { title: string; url: string }[];
      assert.ok(link);
      // The same ticket sent from another thread of the same channel is refused.
      await assert.rejects(
        createMigrationTicket(
          ctxFor(slackAuth(MIGRATION, "U0REP", "1789231999.000001")),
          { description: String(sent.description), link, title: "Forged" }
        ),
        (error: unknown) =>
          error instanceof ExecutorError && error.code === "questions_only"
      );
      // Cancelling is allowed only for a ticket this thread just filed here.
      await cancelMigrationTicket(ctx, "ENG-20001");
      assert.deepEqual(calls[1]?.[2], { id: "ENG-20001", state: "Canceled" });
      await assert.rejects(
        cancelMigrationTicket(ctx, "ENG-1"),
        (error: unknown) =>
          error instanceof ExecutorError && error.code === "questions_only"
      );
      assert.equal(calls.length, 2);
    } finally {
      executorTransport.call = original;
    }
  });
});
describe("eve offers file_migration_ticket only in a ticket-filing thread", () => {
  it("admits the tool with stamped callbacks for the migration thread alone", {
    skip: [COMPILED_MANIFEST_PATH, COMPILE_METADATA_PATH].every((path) =>
      existsSync(new URL(`../../${path}`, import.meta.url))
    )
      ? false
      : "run pnpm validate to compile the repository manifest first",
  }, async () => {
    const { resolveCompiledDynamicTools } = await import(
      "./eve-dynamic-tools.js"
    );
    const manifest = readCompiledManifest(new URL("../../", import.meta.url));
    const entry = manifest.dynamicTools.find(
      (tool) => tool.sourceId === "tools/file_migration_ticket.ts"
    );
    assert.ok(entry, "file_migration_ticket is compiled as a dynamic tool");
    const offered = async (auth: SessionAuthContext, id: string) =>
      (
        await resolveCompiledDynamicTools(entry, manifest.appRoot, {
          auth,
          id: `migration-ticket:${id}`,
        })
      ).map((tool) => tool.name);
    assert.deepEqual(await offered(slackAuth(MIGRATION), "migration"), [
      "file_migration_ticket",
    ]);
    assert.deepEqual(await offered(slackAuth(SANDBOX), "sandbox"), [
      "file_migration_ticket",
    ]);
    assert.deepEqual(await offered(slackAuth(APP_PUBLISHING), "app"), []);
  });
});
