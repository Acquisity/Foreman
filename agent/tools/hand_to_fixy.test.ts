import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionAuthContext } from "eve/context";
import {
  fixyHandoffCommentId,
  parseFixyHandoff,
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
const { handToFixy, handToFixyInputSchema } = await import("./hand_to_fixy.js");

const ENV = { FIXY_TRIAGE_TEAMS: "SAN" };
const ISSUE_ID = "6f1d2c3b-aaaa-4bbb-8ccc-123456789abc";
const TEAM_ID = "team-san";
const COMMENT_ID = fixyHandoffCommentId(ISSUE_ID);
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
  stepsToReproduce: ["Open the Q4 campaign", "Check step 2's sent count"],
  whatHappened: "Step 2 sent nothing since Friday",
  workspaceId: "0A1B2C3D-1111-2222-3333-444455556666",
};

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
    teamLabels?: { id: string; name: string; team: { id: string } | null }[];
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
  const linear: LinearCall = (_query, name, variables) => {
    calls.push({ name, variables });
    const reply = (() => {
      switch (name) {
        case "FixyHandoffIssue":
          return {
            issue: {
              attachments: { nodes: state.attachments },
              comments: { nodes: state.comments },
              createdAt: "2026-11-01T18:02:40.000Z",
              id: ISSUE_ID,
              identifier: "SAN-145",
              labels: { nodes: state.labels },
              team: { id: TEAM_ID, key: state.teamKey },
            },
          };
        case "FixyHandoffCreate": {
          const created = variables.input as { body: string; id: string };
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
        case "FixyBugLabel":
          return {
            issueLabels: {
              nodes: options.teamLabels ?? [
                { id: "bug-other", name: "Bug", team: { id: "team-eng" } },
                { id: "bug-workspace", name: "Bug", team: null },
                { id: "bug-san", name: "Bug", team: { id: TEAM_ID } },
              ],
            },
          };
        case "FixyHandoffLabel": {
          const label = (options.teamLabels ?? []).find(
            (l) => l.id === variables.labelId
          );
          state.labels.push({
            id: String(variables.labelId),
            name: label?.name ?? "Bug",
          });
          return { issueAddLabel: { success: true } };
        }
        default:
          throw new Error(`unexpected ${name}`);
      }
    })();
    return Promise.resolve(reply as never);
  };
  return { calls, linear, names: () => calls.map((call) => call.name), state };
};

describe("hand_to_fixy", () => {
  it("writes the handoff comment, then the issue team's own Bug label", async () => {
    const linear = fakeLinear({
      attachments: [{ title: "Ask from Jo Rep", url: ASK_URL }],
    });
    const result = await handToFixy(input, root, linear.linear, ENV);
    assert.deepEqual(linear.names(), [
      "FixyHandoffIssue",
      "FixyHandoffCreate",
      "FixyBugLabel",
      "FixyHandoffLabel",
    ]);
    const create = linear.calls[1]?.variables.input as Record<string, string>;
    // Top-level, never under the requester's thread comment.
    assert.deepEqual(Object.keys(create).sort(), ["body", "id", "issueId"]);
    assert.equal(create.id, COMMENT_ID);
    assert.equal(create.issueId, ISSUE_ID);
    assert.deepEqual(linear.calls[2]?.variables, {
      name: "Bug",
      teamId: TEAM_ID,
    });
    assert.deepEqual(linear.calls[3]?.variables, {
      id: ISSUE_ID,
      labelId: "bug-san",
    });
    assert.deepEqual(result, {
      alreadyHandedOff: false,
      commentId: COMMENT_ID,
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
  });

  it("uses a workspace-level Bug label when the team has none of its own", async () => {
    const linear = fakeLinear(
      {},
      {
        teamLabels: [
          { id: "bug-other", name: "Bug", team: { id: "team-eng" } },
          { id: "bug-workspace", name: "Bug", team: null },
        ],
      }
    );
    await handToFixy(input, root, linear.linear, ENV);
    assert.equal(linear.calls.at(-1)?.variables.labelId, "bug-workspace");
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
    assert.equal(linear.state.labels.length, 1);
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

  it("reports a team with no Bug label after writing the comment", async () => {
    const linear = fakeLinear({}, { teamLabels: [] });
    const result = await handToFixy(input, root, linear.linear, ENV);
    assert.equal(result.success, false);
    assert.equal(result.commentId, COMMENT_ID);
    assert.ok(result.reason?.includes("no label named Bug"));
    assert.deepEqual(linear.names(), [
      "FixyHandoffIssue",
      "FixyHandoffCreate",
      "FixyBugLabel",
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
  });
});
