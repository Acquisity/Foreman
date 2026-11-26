import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionAuthContext } from "eve/context";
import {
  migrationFiledReport,
  migrationScopeBlock,
  migrationTicketScope,
} from "./migration-ticket-scope.js";
import { readAskFrom } from "./requester-reply.js";
import { slackSessionAuth } from "./session-auth.js";

const MIGRATION = "C0BQM9V6P47";
const APP_PUBLISHING = "C0C8XP8HAFL";

const slackAuth = (channel: string): SessionAuthContext =>
  slackSessionAuth(
    {
      attributes: {
        author_type: "user",
        channel_id: channel,
        thread_ts: "1789231558.984729",
        user_id: "U0REP",
      },
      authenticator: "slack-webhook",
      principalId: "slack:T1:U0REP",
      principalType: "user",
    },
    { intakeOnly: true, questionsOnly: true }
  );

describe("a filed ticket reaches Foreman's triage", () => {
  const readsBack = (description: string, attachments: unknown[] = []) => ({
    fetch: (async () =>
      Response.json({
        data: {
          issue: {
            attachments: { nodes: attachments },
            description,
            documents: { nodes: [] },
          },
        },
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
    assert.deepEqual(ask, {
      requester: "rep@example.com",
      supportScope: null,
      triageIntake: true,
    });
  });

  it("does not trust a scope block that is not at the very end", async () => {
    const ask = await readAskFrom(
      "ENG-20001",
      { accessToken: "token" },
      readsBack(`${filed}\n\nAnd more text after it.`)
    );
    assert.deepEqual(ask, {
      requester: null,
      supportScope: null,
      triageIntake: false,
    });
    assert.equal(
      migrationFiledReport(filed.replace(MIGRATION, APP_PUBLISHING)),
      null
    );
  });
});
