import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionAuthContext } from "eve/context";
import type { ApprovalContext } from "eve/tools/approval";
import { executorClient } from "./executor/client.js";
import { executorConnection } from "./executor/connection.js";
import { ExecutorError } from "./executor/transport.js";
import {
  QUESTIONS_ONLY_REASON,
  questionsOnlyPolicy,
} from "./github/approval.js";
import { slackSessionAuth } from "./session-auth.js";
import {
  admitsSlackMention,
  QUESTIONS_ONLY_CHANNELS,
  QUESTIONS_ONLY_WORKSPACE,
  resolveSlackIntakeWorkflow,
  SLACK_INTAKE_WORKFLOWS,
  slackIntakeContext,
} from "./slack-intake.js";
import {
  lookupSlackRequester,
  slackRequesterContext,
} from "./slack-requester.js";
import { isIntakeOnly, isQuestionsOnly } from "./trust.js";

const MIGRATION = "C0BQM9V6P47";
const SANDBOX = "C0C6DM2MB39";
const WORKSPACE_ID = new RegExp(QUESTIONS_ONLY_WORKSPACE.id, "u");
const WORKSPACE_NAME = /AI Acquisition Sales Team/u;
const NO_LINEAR_WORK = /Do not create or change Linear issues/u;
const FORM_COMMAND = /\/acquisityasks/u;
const TEXT_IS_NOT_IDENTITY = /never the requester's identity/u;
const INTAKE_LINEAR_WRITES = /create or update Linear records/u;
const GENERIC_NEW_ISSUE = /Create exactly one unassigned Linear issue/u;
const REP_EMAIL = /rep@example\.com/u;
const KEEP_IT_QUICK = /aim to reply within about five minutes/u;
const GENERAL_HELP_ONLY = /return no user-specific or record-specific data/u;

const slackAuth: SessionAuthContext = {
  attributes: {},
  authenticator: "slack",
  principalId: "user:U0REP",
  principalType: "user",
};

const questionsAuth = slackSessionAuth(slackAuth, {
  intakeOnly: true,
  questionsOnly: true,
});
const ordinaryAuth = slackSessionAuth(slackAuth, { intakeOnly: false });

const approvalFor = (
  current: SessionAuthContext,
  initiator: SessionAuthContext | null = current,
  toolName = "route_ticket"
) =>
  ({
    approvedTools: [],
    session: { auth: { current, initiator } },
    toolInput: {},
    toolName,
  }) as unknown as ApprovalContext;

describe("questions-only channel", () => {
  it("maps the migration channel to the questions-only workflow", () => {
    assert.equal(QUESTIONS_ONLY_CHANNELS.has(MIGRATION), true);
    // The private sandbox twin runs the same path for Preview testing.
    assert.equal(SLACK_INTAKE_WORKFLOWS[SANDBOX]?.mode, "questions-only");
    assert.equal(SLACK_INTAKE_WORKFLOWS[MIGRATION]?.mode, "questions-only");
    assert.deepEqual(resolveSlackIntakeWorkflow(MIGRATION)?.skills, [
      "clarify-with-requester",
    ]);
  });

  it("admits a person's tag, unlike the receiver-only Asks channels", () => {
    const person = {
      fullName: "Rep",
      isBot: false,
      isMe: false,
      userId: "U0REP",
      userName: "rep",
    };
    assert.equal(admitsSlackMention(MIGRATION, person), true);
    assert.equal(admitsSlackMention("C0BBPVC3N2X", person), false);
  });

  it("pins the workspace and forbids Linear work in the injected task", () => {
    const context = slackIntakeContext(MIGRATION);
    assert.match(context, WORKSPACE_ID);
    assert.match(context, WORKSPACE_NAME);
    assert.match(context, NO_LINEAR_WORK);
    assert.match(context, FORM_COMMAND);
    assert.match(context, TEXT_IS_NOT_IDENTITY);
    assert.match(context, KEEP_IT_QUICK);
    assert.doesNotMatch(context, INTAKE_LINEAR_WRITES);
    assert.doesNotMatch(context, GENERIC_NEW_ISSUE);
  });

  it("stamps the session questions-only and intake-only", () => {
    assert.equal(isQuestionsOnly(questionsAuth), true);
    assert.equal(isIntakeOnly(questionsAuth), true);
    assert.equal(isQuestionsOnly(ordinaryAuth), false);
  });
});

describe("questions-only Linear write block", () => {
  it("denies the Linear-writing root tools for the caller or the initiator", () => {
    assert.deepEqual(questionsOnlyPolicy(approvalFor(questionsAuth)), {
      reason: QUESTIONS_ONLY_REASON,
      type: "denied",
    });
    // A delegated child carries the stamp through the session initiator.
    assert.deepEqual(
      questionsOnlyPolicy(approvalFor(ordinaryAuth, questionsAuth)),
      { reason: QUESTIONS_ONLY_REASON, type: "denied" }
    );
    assert.equal(
      questionsOnlyPolicy(approvalFor(ordinaryAuth)),
      "not-applicable"
    );
  });

  it("denies the raw Executor gateway, which can run any Linear write", () => {
    const approve = executorConnection().approval as (
      context: never
    ) => unknown;
    assert.deepEqual(
      approve(
        approvalFor(questionsAuth, questionsAuth, "executor__execute") as never
      ),
      { reason: QUESTIONS_ONLY_REASON, type: "denied" }
    );
    assert.equal(
      approve(
        approvalFor(ordinaryAuth, ordinaryAuth, "executor__execute") as never
      ),
      "not-applicable"
    );
  });

  it("refuses a Linear mutation in the typed client before any binding or dispatch", async () => {
    const ctx = {
      abortSignal: AbortSignal.timeout(1000),
      getToken: () =>
        assert.fail("a refused write must not resolve credentials"),
      session: { auth: { current: questionsAuth, initiator: questionsAuth } },
    } as never;
    const client = executorClient(ctx);
    await assert.rejects(
      client({
        input: { variables: {} },
        operation: "linear.RouteIssueUpdate",
      } as never),
      (error: unknown) =>
        error instanceof ExecutorError &&
        error.code === "questions_only" &&
        error.dispatched === false
    );
    // A read passes the guard and stops later, at the missing test binding.
    await assert.rejects(
      client({
        input: { variables: {} },
        operation: "linear.RouteIssue",
      } as never),
      (error: unknown) =>
        error instanceof ExecutorError && error.code !== "questions_only"
    );
  });
});

describe("questions-only requester identity", () => {
  const usersInfo = (body: unknown, status = 200) =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
      })) as unknown as typeof fetch;
  const token = async () => "xoxb-test";

  it("reads name and email from the Slack profile", async () => {
    const requester = await lookupSlackRequester("U0REP", {
      fetchImpl: usersInfo({
        ok: true,
        user: { profile: { email: "Rep@Example.com", real_name: "Rep One" } },
      }),
      token,
    });
    assert.deepEqual(requester, {
      email: "rep@example.com",
      name: "Rep One",
      status: "known",
    });
    assert.match(slackRequesterContext(requester), REP_EMAIL);
  });

  it("is unknown without an email, on a Slack error, or on a bad id", async () => {
    const noEmail = await lookupSlackRequester("U0REP", {
      fetchImpl: usersInfo({ ok: true, user: { profile: {} } }),
      token,
    });
    const slackError = await lookupSlackRequester("U0REP", {
      fetchImpl: usersInfo({ error: "missing_scope", ok: false }),
      token,
    });
    const httpError = await lookupSlackRequester("U0REP", {
      fetchImpl: usersInfo({}, 500),
      token,
    });
    const thrown = await lookupSlackRequester("U0REP", {
      fetchImpl: (() =>
        Promise.reject(new Error("timeout"))) as unknown as typeof fetch,
      token,
    });
    const badId = await lookupSlackRequester("not-an-id", {
      fetchImpl: () => assert.fail("a bad id must not call Slack"),
      token,
    });
    for (const result of [noEmail, slackError, httpError, thrown, badId]) {
      assert.deepEqual(result, { status: "unknown" });
    }
    assert.match(
      slackRequesterContext({ status: "unknown" }),
      GENERAL_HELP_ONLY
    );
  });

  it("treats bots and deleted users as unknown", async () => {
    const results = await Promise.all(
      [
        { is_bot: true, profile: { email: "bot@example.com" } },
        { deleted: true, profile: { email: "gone@example.com" } },
      ].map((user) =>
        lookupSlackRequester("U0REP", {
          fetchImpl: usersInfo({ ok: true, user }),
          token,
        })
      )
    );
    for (const result of results) {
      assert.deepEqual(result, { status: "unknown" });
    }
  });
});
