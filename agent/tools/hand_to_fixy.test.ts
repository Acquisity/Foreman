import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionAuthContext } from "eve/context";
import {
  fixyHandoffCommentId,
  parseFixyHandoff,
  renderFixyHandoff,
  SLACK_THREAD_START,
  TICKET_CREATED,
} from "#lib/fixy-handoff.js";
import { stampQuestionsOnly, stampTrusted } from "#lib/trust.js";
import type {
  HandoffSession,
  HandToFixyInput,
  LinearCall,
} from "./hand_to_fixy.js";

// The tool module resolves Foreman's Linear connector as it loads.
process.env.LINEAR_CONNECTOR ??= "stub/stub";
const {
  default: tool,
  handToFixy,
  handToFixyInputSchema,
  handoffOutcome,
} = await import("./hand_to_fixy.js");

const ENV = { FIXY_TRIAGE_TEAMS: "SAN" };
const ISSUE_ID = "6f1d2c3b-aaaa-4bbb-8ccc-123456789abc";
const TEAM_ID = "team-san";
const COMMENT_ID = fixyHandoffCommentId(ISSUE_ID);
const LANES_LINE = /^Lanes: .*\n/mu;
const QUERY_NAME = /(?:query|mutation)\s+(\w+)/u;
// Measured shape: SAN-124's 'Ask from' link into the receiver sandbox.
const ASK_URL =
  "https://acquisityworkspace.slack.com/archives/C0BLFDUN6Q7/p1793556157524579";

const linearAuthContext: SessionAuthContext = {
  attributes: {},
  authenticator: "linear-webhook",
  issuer: "linear",
  principalId: "linear:user",
  principalType: "user",
};
const root: HandoffSession = {
  auth: {
    current: stampTrusted(linearAuthContext),
    initiator: stampTrusted(linearAuthContext),
  },
  id: "session-1",
};

const input: HandToFixyInput = {
  expected: "The campaign sends its follow-up step",
  issue: "SAN-145",
  lanes: ["eng"],
  stepsToReproduce: ["Open the Q4 campaign", "Check step 2's sent count"],
  whatHappened: "Step 2 sent nothing since Friday",
  workspaceId: "0A1B2C3D-1111-2222-3333-444455556666",
};

interface LabelRow {
  id: string;
  name: string;
  team: { id: string } | null;
}
// fixy is a workspace label in Linear; the lane labels are not created yet.
const LABELS: LabelRow[] = [
  { id: "bug-workspace", name: "Bug", team: null },
  { id: "fixy-other", name: "fixy", team: { id: "team-eng" } },
  { id: "fixy-workspace", name: "fixy", team: null },
  ...["billing", "unblock", "eng", "question"].map((lane) => ({
    id: `lane-${lane}`,
    name: `lane:${lane}`,
    team: { id: TEAM_ID },
  })),
];

interface Ticket {
  attachments: { title: string; url: string }[];
  comments: { body: string; id: string }[];
  labels: { id: string; name: string }[];
  teamKey: string;
}

/** A fake Linear that records every call, in order, against one ticket. */
const fakeLinear = (
  ticket: Partial<Ticket> = {},
  options: {
    hidden?: boolean;
    fail?: string;
    labelsRejected?: boolean;
    lookupFails?: boolean;
    teamLabels?: LabelRow[];
  } = {}
) => {
  const state: Ticket = {
    attachments: [],
    comments: [],
    labels: [],
    teamKey: "SAN",
    ...ticket,
  };
  const calls: { name: string; variables: Record<string, unknown> }[] = [];
  const linear: LinearCall = async (_query, name, variables) => {
    calls.push({ name, variables });
    if (name === options.fail) {
      throw new Error("provider unavailable");
    }
    const reply = (() => {
      switch (name) {
        case "FixyHandoffIssue":
          return {
            issue: {
              attachments: { nodes: state.attachments },
              comments: {
                nodes: options.hidden ? [] : state.comments,
                pageInfo: { hasNextPage: options.hidden ?? false },
              },
              createdAt: "2026-11-01T18:02:40.000Z",
              id: ISSUE_ID,
              identifier: "SAN-145",
              labels: { nodes: state.labels },
              team: { id: TEAM_ID, key: state.teamKey },
            },
          };
        case "FixyHandoffComment": {
          const found = state.comments.find((c) => c.id === variables.id);
          if (options.lookupFails) {
            throw Object.assign(
              new Error("Linear GraphQL failed with HTTP 500."),
              {
                body: null,
              }
            );
          }
          // Real Linear answers an unknown comment id with this error body.
          if (!found) {
            throw Object.assign(
              new Error("Linear GraphQL failed with HTTP 200."),
              {
                body: {
                  data: null,
                  errors: [{ message: "Entity not found: Comment" }],
                },
              }
            );
          }
          return { comment: found };
        }
        case "FixyHandoffCreate": {
          const created = variables.input as { body: string; id: string };
          if (state.comments.some((c) => c.id === created.id)) {
            throw new Error("id already exists");
          }
          state.comments.push({ body: created.body, id: created.id });
          return {
            commentCreate: { comment: { id: created.id }, success: true },
          };
        }
        case "FixyHandoffUpdate": {
          const comment = state.comments.find((c) => c.id === variables.id);
          if (!comment) {
            throw new Error("Entity not found");
          }
          comment.body = (variables.input as { body: string }).body;
          return { commentUpdate: { success: true } };
        }
        case "FixyLabels": {
          const names = variables.names as string[];
          return {
            issueLabels: {
              nodes: (options.teamLabels ?? LABELS).filter((l) =>
                names.includes(l.name)
              ),
            },
          };
        }
        case "FixyHandoffLabels": {
          const ids = (variables.input as { addedLabelIds: string[] })
            .addedLabelIds;
          if (options.labelsRejected) {
            return { issueUpdate: { success: false } };
          }
          for (const id of ids) {
            const label = (options.teamLabels ?? LABELS).find(
              (l) => l.id === id
            );
            state.labels.push({ id, name: label?.name ?? id });
          }
          return { issueUpdate: { success: true } };
        }
        default:
          throw new Error(`unexpected ${name}`);
      }
    })();
    return await Promise.resolve(reply as never);
  };
  return { calls, linear, names: () => calls.map((call) => call.name), state };
};

describe("hand_to_fixy", () => {
  it("writes the handoff comment, then the fixy and lane labels, never Bug", async () => {
    const linear = fakeLinear({
      attachments: [{ title: "Ask from Jo Rep", url: ASK_URL }],
    });
    const result = await handToFixy(input, root, linear.linear, ENV);
    assert.deepEqual(linear.names(), [
      "FixyHandoffIssue",
      "FixyHandoffCreate",
      "FixyLabels",
      "FixyHandoffLabels",
    ]);
    const create = linear.calls[1]?.variables.input as Record<string, string>;
    // Top-level, never under the requester's thread comment.
    assert.deepEqual(Object.keys(create).sort(), ["body", "id", "issueId"]);
    assert.equal(create.id, COMMENT_ID);
    assert.equal(create.issueId, ISSUE_ID);
    assert.deepEqual(linear.calls[2]?.variables, {
      names: ["fixy", "lane:eng"],
      teamId: TEAM_ID,
    });
    assert.deepEqual(linear.calls[3]?.variables, {
      id: ISSUE_ID,
      input: { addedLabelIds: ["fixy-workspace", "lane-eng"] },
    });
    assert.deepEqual(result, {
      alreadyHandedOff: false,
      commentId: COMMENT_ID,
      fixyNotified: true,
      issue: "SAN-145",
      labelAdded: true,
      reportedAt: "2026-11-01T18:02:37.524Z",
      reportedAtSource: SLACK_THREAD_START,
      success: true,
      warnings: [],
    });
    const stored = parseFixyHandoff(create.body);
    assert.equal(stored?.workspaceId, "0a1b2c3d-1111-2222-3333-444455556666");
    assert.deepEqual(stored?.steps, input.stepsToReproduce);
    assert.deepEqual(stored?.lanes, ["eng"]);
    assert.ok(create.body.includes("\nLanes: eng\nCard: none\n"));
  });

  it("hands a billing and question ask over with no steps and both lane labels", async () => {
    const linear = fakeLinear();
    const result = await handToFixy(
      { ...input, lanes: ["billing", "question"], stepsToReproduce: [] },
      root,
      linear.linear,
      ENV
    );
    assert.equal(result.success, true);
    assert.equal(result.fixyNotified, true);
    assert.deepEqual(
      linear.state.labels.map((label) => label.name),
      ["fixy", "lane:billing", "lane:question"]
    );
    const stored = parseFixyHandoff(linear.state.comments[0]?.body ?? "");
    assert.deepEqual(stored?.lanes, ["billing", "question"]);
    assert.deepEqual(stored?.steps, []);
  });

  it("still parses a handoff written before lanes, and needs steps there and for eng", () => {
    const old = [
      "## Fixy handoff",
      "",
      "Workspace ID: 0a1b2c3d-1111-2222-3333-444455556666",
      "Reported at: 2026-11-01T18:02:37.524Z (Slack thread start)",
      "What happened: Step 2 sent nothing",
      "Expected: The step sends",
      "",
      "Steps to reproduce:",
      "1. Open the campaign",
    ].join("\n");
    assert.deepEqual(parseFixyHandoff(old)?.lanes, []);
    assert.equal(
      parseFixyHandoff(old.replace("\n1. Open the campaign", "")),
      null
    );
    const eng = old.replace(
      "Expected: The step sends",
      "Expected: The step sends\nLanes: eng\nCard: none"
    );
    assert.deepEqual(parseFixyHandoff(eng)?.lanes, ["eng"]);
    assert.equal(
      parseFixyHandoff(eng.replace("\n1. Open the campaign", "")),
      null
    );
    assert.equal(
      parseFixyHandoff(eng.replace("Lanes: eng", "Lanes: sales")),
      null
    );
  });

  it("adds only missing lane labels on a ticket that already carries fixy", async () => {
    const linear = fakeLinear({
      labels: [
        { id: "fixy-workspace", name: "fixy" },
        { id: "lane-billing", name: "lane:billing" },
      ],
    });
    const result = await handToFixy(
      { ...input, lanes: ["billing", "eng"] },
      root,
      linear.linear,
      ENV
    );
    assert.deepEqual(linear.calls[2]?.variables.names, ["lane:eng"]);
    assert.equal(result.success, true);
    assert.equal(result.alreadyHandedOff, true);
    assert.equal(result.fixyNotified, false);
    assert.equal(handoffOutcome(result), "updated");
  });

  it("adds nothing when fixy or a lane label is missing, naming each one", async () => {
    for (const [missing, names] of [
      ["fixy", ["fixy"]],
      ["lane:billing", ["lane:billing"]],
    ] as const) {
      const linear = fakeLinear(
        {},
        { teamLabels: LABELS.filter((label) => label.name !== missing) }
      );
      // biome-ignore lint/performance/noAwaitInLoops: one fake Linear per case, in order so a failure names its case.
      const result = await handToFixy(
        { ...input, lanes: ["eng", "billing"] },
        root,
        linear.linear,
        ENV
      );
      assert.equal(result.success, false);
      assert.equal(result.commentId, COMMENT_ID);
      assert.ok(result.reason?.includes(`no label named ${names.join(", ")}`));
      assert.ok(!linear.names().includes("FixyHandoffLabels"));
      assert.deepEqual(linear.state.labels, []);
    }
  });

  it("writes a first handoff on a ticket whose comments run past one page", async () => {
    const linear = fakeLinear({}, { hidden: true });
    const result = await handToFixy(input, root, linear.linear, ENV);
    assert.equal(result.success, true);
    assert.equal(result.labelAdded, true);
    assert.ok(linear.names().includes("FixyHandoffComment"));
    assert.equal(linear.state.comments.length, 1);
  });

  it("never mistakes a failed paged lookup for a missing handoff", async () => {
    const options = { hidden: true, lookupFails: false };
    const linear = fakeLinear({}, options);
    await handToFixy(
      {
        ...input,
        reportedAt: "2026-10-31T09:15:00Z",
        reportedAtSource: "Intercom first message",
      },
      root,
      linear.linear,
      ENV
    );
    const stored = linear.state.comments[0]?.body;
    options.lookupFails = true;
    await assert.rejects(
      handToFixy({ ...input, notes: "New detail" }, root, linear.linear, ENV)
    );
    assert.equal(linear.state.comments[0]?.body, stored);
  });

  for (const hidden of [false, true]) {
    it(`preserves the original report time on ${hidden ? "paginated" : "visible"} follow-ups`, async () => {
      const linear = fakeLinear({}, { hidden });
      await handToFixy(
        {
          ...input,
          reportedAt: "2026-10-31T09:15:00Z",
          reportedAtSource: "Intercom first message",
        },
        root,
        linear.linear,
        ENV
      );
      const result = await handToFixy(
        { ...input, notes: "Workspace confirmed" },
        root,
        linear.linear,
        ENV
      );
      assert.equal(result.reportedAt, "2026-10-31T09:15:00.000Z");
      assert.equal(result.reportedAtSource, "Intercom first message");
      assert.equal(
        parseFixyHandoff(linear.state.comments[0]?.body ?? "")?.reportedAt,
        result.reportedAt
      );
      if (hidden) {
        assert.ok(linear.names().includes("FixyHandoffComment"));
      }
      // Explicit replacement wins over the previous time.
      const replaced = await handToFixy(
        {
          ...input,
          reportedAt: "2026-10-30T00:00:00Z",
          reportedAtSource: "Requester correction",
        },
        root,
        linear.linear,
        ENV
      );
      assert.equal(replaced.reportedAt, "2026-10-30T00:00:00.000Z");
      linear.state.attachments.push({ title: "Ask from Jo", url: ASK_URL });
      const slack = await handToFixy(input, root, linear.linear, ENV);
      assert.equal(slack.reportedAtSource, SLACK_THREAD_START);
    });
  }

  it("writes a missing handoff with fixy already present without notifying Fixy", async () => {
    const linear = fakeLinear({
      labels: [
        { id: "fixy-workspace", name: "fixy" },
        { id: "lane-eng", name: "lane:eng" },
      ],
    });
    const result = await handToFixy(input, root, linear.linear, ENV);
    assert.equal(result.success, true);
    assert.equal(result.fixyNotified, false);
    assert.equal(result.commentId, COMMENT_ID);
    assert.deepEqual(linear.names(), ["FixyHandoffIssue", "FixyHandoffCreate"]);
  });

  for (const fail of ["FixyLabels", "FixyHandoffLabels"]) {
    it(`keeps confirmed comment progress when ${fail} throws`, async () => {
      const linear = fakeLinear({}, { fail });
      const result = await handToFixy(input, root, linear.linear, ENV);
      assert.equal(result.success, false);
      assert.equal(result.commentId, COMMENT_ID);
      assert.equal(result.reportedAtSource, TICKET_CREATED);
      assert.equal(result.reportedAt, "2026-11-01T18:02:40.000Z");
      assert.equal(handoffOutcome(result), "comment_only");
      assert.ok(result.reason?.includes("could not be confirmed"));
    });
  }

  for (const fail of ["FixyLabels", "FixyHandoffLabels"]) {
    it(`logs comment_only from execute when ${fail} throws after writing`, async () => {
      const linear = fakeLinear({}, { fail });
      const originalFetch = globalThis.fetch;
      const originalInfo = console.info;
      const teams = process.env.FIXY_TRIAGE_TEAMS;
      const events: string[] = [];
      process.env.FIXY_TRIAGE_TEAMS = "SAN";
      console.info = (line: string) => {
        events.push(line);
      };
      globalThis.fetch = async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        const data = await linear.linear(
          request.query,
          request.operationName ?? QUERY_NAME.exec(request.query)?.[1],
          request.variables
        );
        return Response.json({ data });
      };
      try {
        assert.ok(tool.execute);
        const ctx = {
          abortSignal: new AbortController().signal,
          getToken: () => Promise.resolve({ token: "synthetic" }),
          session: root,
        } as unknown as Parameters<typeof tool.execute>[1];
        const result = await tool.execute(input, ctx);
        assert.ok("success" in result);
        assert.equal(result.success, false);
        assert.equal(result.commentId, COMMENT_ID);
        assert.equal(result.reportedAtSource, TICKET_CREATED);
        assert.ok(
          events.some((line) => line.includes('"outcome":"comment_only"'))
        );
      } finally {
        globalThis.fetch = originalFetch;
        console.info = originalInfo;
        if (teams === undefined) {
          Reflect.deleteProperty(process.env, "FIXY_TRIAGE_TEAMS");
        } else {
          process.env.FIXY_TRIAGE_TEAMS = teams;
        }
      }
    });
  }

  it("still throws cancellation after the comment write", async () => {
    const linear = fakeLinear({}, { fail: "FixyLabels" });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      handToFixy(input, root, linear.linear, ENV, controller.signal)
    );
  });

  it("describes this session's report ticket and no notification for an existing fixy label", () => {
    assert.ok(tool.description?.includes("this session's report ticket"));
    assert.ok(
      tool.description?.includes("fixyNotified false means no run was notified")
    );
  });

  it("prefers the team's own label over a workspace label", async () => {
    const linear = fakeLinear(
      {},
      {
        teamLabels: [
          ...LABELS,
          { id: "fixy-san", name: "fixy", team: { id: TEAM_ID } },
        ],
      }
    );
    await handToFixy(input, root, linear.linear, ENV);
    assert.deepEqual(linear.calls.at(-1)?.variables.input, {
      addedLabelIds: ["fixy-san", "lane-eng"],
    });
  });

  it("keeps earlier lanes and engineering steps when adding a billing lane", async () => {
    const linear = fakeLinear();
    await handToFixy(input, root, linear.linear, ENV);
    const result = await handToFixy(
      { ...input, lanes: ["billing"], stepsToReproduce: [] },
      root,
      linear.linear,
      ENV
    );
    assert.equal(result.success, true);
    const stored = parseFixyHandoff(linear.state.comments[0]?.body ?? "");
    assert.deepEqual(stored?.lanes, ["billing", "eng"]);
    assert.deepEqual(stored?.steps, input.stepsToReproduce);
    assert.deepEqual(
      linear.state.labels.map((label) => label.name),
      ["fixy", "lane:eng", "lane:billing"]
    );
  });

  it("adds the lane labels of every recorded lane when an earlier label write did not land", async () => {
    const linear = fakeLinear();
    await handToFixy(input, root, linear.linear, ENV);
    linear.state.labels.length = 0;
    const result = await handToFixy(
      { ...input, lanes: ["billing"], stepsToReproduce: [] },
      root,
      linear.linear,
      ENV
    );
    assert.equal(result.success, true);
    assert.deepEqual(
      linear.state.labels.map((label) => label.name),
      ["fixy", "lane:billing", "lane:eng"]
    );
  });

  it("keeps a pre-lane handoff's steps when a follow-up adds only a billing lane", async () => {
    const legacy = renderFixyHandoff({
      expected: "It sends",
      lanes: [],
      notes: null,
      reportedAt: "2026-11-01T00:00:00.000Z",
      reportedAtSource: "Slack thread start",
      steps: ["Open the campaign"],
      whatHappened: "It did not send",
      workspaceId: null,
      workspaceUnknown: "not found",
    }).replace(LANES_LINE, "");
    const linear = fakeLinear({
      comments: [{ body: legacy, id: fixyHandoffCommentId(ISSUE_ID) }],
    });
    const result = await handToFixy(
      { ...input, lanes: ["billing"], stepsToReproduce: [] },
      root,
      linear.linear,
      ENV
    );
    assert.equal(result.success, true);
    const stored = parseFixyHandoff(linear.state.comments[0]?.body ?? "");
    assert.deepEqual(stored?.steps, ["Open the campaign"]);
  });

  it("reports a comment-only failure when Linear rejects the label write", async () => {
    const linear = fakeLinear({}, { labelsRejected: true });
    const result = await handToFixy(input, root, linear.linear, ENV);
    assert.equal(result.success, false);
    assert.equal(result.labelAdded, false);
    assert.ok(result.commentId);
    assert.deepEqual(linear.state.labels, []);
  });

  it("is idempotent: a second call updates the comment and writes no label", async () => {
    const linear = fakeLinear();
    await handToFixy(input, root, linear.linear, ENV);
    const before = linear.calls.length;
    const result = await handToFixy(
      { ...input, notes: "Workspace confirmed by the requester" },
      root,
      linear.linear,
      ENV
    );
    assert.deepEqual(linear.names().slice(before), [
      "FixyHandoffIssue",
      "FixyHandoffUpdate",
    ]);
    assert.equal(linear.state.comments.length, 1);
    assert.equal(linear.state.labels.length, 2);
    assert.equal(result.alreadyHandedOff, true);
    assert.equal(result.labelAdded, false);
    assert.equal(result.success, true);
    assert.equal(
      parseFixyHandoff(linear.state.comments[0]?.body ?? "")?.notes,
      "Workspace confirmed by the requester"
    );
    // The same handoff again changes nothing at all.
    const third = linear.calls.length;
    await handToFixy(
      { ...input, notes: "Workspace confirmed by the requester" },
      root,
      linear.linear,
      ENV
    );
    assert.deepEqual(linear.names().slice(third), ["FixyHandoffIssue"]);
  });

  it("updates a handoff it could not see when the create is refused", async () => {
    const linear = fakeLinear({
      comments: [{ body: "older handoff", id: COMMENT_ID }],
    });
    // The handoff sits past the first page of comments.
    const hidden: LinearCall = <T>(
      query: string,
      name: string,
      variables: Parameters<LinearCall>[2]
    ) => {
      if (name === "FixyHandoffCreate") {
        return Promise.reject(new Error("id already exists"));
      }
      return linear.linear<T>(query, name, variables).then((read) => {
        if (name === "FixyHandoffIssue") {
          const r = read as { issue: { comments: { nodes: unknown[] } } };
          r.issue.comments.nodes = [];
          (r.issue.comments as { pageInfo?: unknown }).pageInfo = {
            hasNextPage: true,
          };
        }
        return read;
      });
    };
    const result = await handToFixy(input, root, hidden, ENV);
    assert.equal(result.success, true);
    assert.equal(linear.state.comments.length, 1);
    assert.ok(linear.state.comments[0]?.body.startsWith("## Fixy handoff"));
  });

  it("refuses outside FIXY_TRIAGE_TEAMS before any Linear call", async () => {
    for (const [issue, env] of [
      ["ENG-17117", ENV],
      ["SAN-145", {}],
      ["SAN-145", { FIXY_TRIAGE_TEAMS: "" }],
    ] as const) {
      const linear = fakeLinear();
      // biome-ignore lint/performance/noAwaitInLoops: one fake Linear per case, in order so a failure names its case.
      const result = await handToFixy(
        { ...input, issue },
        root,
        linear.linear,
        env
      );
      assert.equal(result.success, false);
      assert.ok(result.reason?.includes("FIXY_TRIAGE_TEAMS"));
      assert.deepEqual(linear.calls, []);
    }
  });

  it("refuses an issue that has moved off a listed team, writing nothing", async () => {
    const linear = fakeLinear({ teamKey: "ENG" });
    const result = await handToFixy(input, root, linear.linear, ENV);
    assert.equal(result.success, false);
    assert.ok(result.reason?.includes("team ENG"));
    assert.deepEqual(linear.names(), ["FixyHandoffIssue"]);
  });

  it("refuses a delegated child and a questions-only session", async () => {
    const questions = stampQuestionsOnly(stampTrusted(linearAuthContext));
    for (const session of [
      {
        ...root,
        parent: {
          callId: "call-1",
          rootSessionId: "root",
          sessionId: "root",
          turn: { id: "turn-1", sequence: 1 },
        },
      },
      { ...root, auth: { current: questions, initiator: questions } },
      { ...root, auth: { current: root.auth.current, initiator: questions } },
    ]) {
      const linear = fakeLinear();
      // biome-ignore lint/performance/noAwaitInLoops: one fake Linear per case, in order so a failure names its case.
      const result = await handToFixy(input, session, linear.linear, ENV);
      assert.equal(result.success, false);
      assert.deepEqual(linear.calls, []);
    }
  });

  it("takes the report time from Slack, then the input, then ticket creation", async () => {
    const cases = [
      {
        attachments: [
          { title: "Ask from Jo", url: "https://example.com/not-slack" },
          { title: "Ask from Jo", url: ASK_URL },
        ],
        expected: ["2026-11-01T18:02:37.524Z", SLACK_THREAD_START],
        extra: { reportedAt: "2026-10-01T00:00:00Z", reportedAtSource: "x" },
      },
      {
        attachments: [{ title: "Design", url: ASK_URL }],
        expected: ["2026-10-31T09:15:00.000Z", "Intercom first message"],
        extra: {
          reportedAt: "2026-10-31T09:15:00Z",
          reportedAtSource: "Intercom first message",
        },
      },
      {
        attachments: [],
        expected: ["2026-11-01T18:02:40.000Z", TICKET_CREATED],
        extra: {},
      },
    ];
    for (const { attachments, expected, extra } of cases) {
      const linear = fakeLinear({ attachments });
      // biome-ignore lint/performance/noAwaitInLoops: one fake Linear per case, in order so a failure names its case.
      const result = await handToFixy(
        { ...input, ...extra },
        root,
        linear.linear,
        ENV
      );
      assert.deepEqual([result.reportedAt, result.reportedAtSource], expected);
      const body = (
        linear.calls[1]?.variables.input as { body: string } | undefined
      )?.body;
      assert.ok(body?.includes(`Reported at: ${expected[0]} (${expected[1]})`));
      assert.equal(
        result.warnings.length,
        expected[1] === TICKET_CREATED ? 1 : 0
      );
    }
  });

  it("sanitises fields and refuses one left empty, before any write", async () => {
    const linear = fakeLinear();
    await handToFixy(
      {
        ...input,
        stepsToReproduce: ["Open `Inbox`\n# Heading", "Click [Sync](x)"],
        whatHappened: "Sync failed\n\n<!-- note -->",
      },
      root,
      linear.linear,
      ENV
    );
    const written = linear.calls[1]?.variables.input as { body: string };
    const stored = parseFixyHandoff(written.body);
    assert.deepEqual(stored?.steps, ["Open Inbox Heading", "Click Sync(x)"]);
    assert.equal(stored?.whatHappened, "Sync failed !-- note --");

    const empty = fakeLinear();
    const result = await handToFixy(
      { ...input, expected: "```" },
      root,
      empty.linear,
      ENV
    );
    assert.equal(result.success, false);
    assert.deepEqual(empty.names(), ["FixyHandoffIssue"]);
  });

  it("reports a team with none of the labels after writing the comment", async () => {
    const linear = fakeLinear({}, { teamLabels: [] });
    const result = await handToFixy(input, root, linear.linear, ENV);
    assert.equal(result.success, false);
    assert.equal(result.commentId, COMMENT_ID);
    assert.ok(result.reason?.includes("no label named fixy, lane:eng"));
    assert.deepEqual(linear.names(), [
      "FixyHandoffIssue",
      "FixyHandoffCreate",
      "FixyLabels",
    ]);
  });

  it("needs exactly one of workspaceId and workspaceUnknown, and a source for reportedAt", () => {
    const { workspaceId: _, ...noWorkspace } = input;
    assert.equal(handToFixyInputSchema.safeParse(noWorkspace).success, false);
    assert.equal(
      handToFixyInputSchema.safeParse({ ...input, workspaceUnknown: "x" })
        .success,
      false
    );
    assert.equal(
      handToFixyInputSchema.safeParse({ ...noWorkspace, workspaceUnknown: "x" })
        .success,
      true
    );
    assert.equal(
      handToFixyInputSchema.safeParse({
        ...input,
        reportedAt: "2026-10-31T09:15:00Z",
      }).success,
      false
    );
    assert.equal(
      handToFixyInputSchema.safeParse({ ...input, stepsToReproduce: [] })
        .success,
      false
    );
    const { stepsToReproduce: _steps, ...noSteps } = input;
    assert.equal(
      handToFixyInputSchema.safeParse({ ...noSteps, lanes: ["billing"] })
        .success,
      true
    );
    for (const lanes of [[], ["eng", "eng"], ["sales"]]) {
      assert.equal(
        handToFixyInputSchema.safeParse({ ...input, lanes }).success,
        false
      );
    }
    assert.equal(
      handToFixyInputSchema.safeParse({ ...input, card: "refund" }).success,
      false
    );
  });
});
