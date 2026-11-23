import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type WidgetCase, widgetCaseSchema } from "./widget-case.js";
import { answeredLane, handedOff, leaks, rawFields } from "./widget-graders.js";

const recorded = widgetCaseSchema.parse(
  JSON.parse(
    readFileSync("agent/lib/fixtures/widget-case-paused-campaign.json", "utf8")
  )
);
const expecting = (
  expectations: Partial<WidgetCase["expectations"]>
): WidgetCase => ({
  ...recorded,
  expectations: { ...recorded.expectations, ...expectations },
});
const REPLY = "Your campaign is paused because two inboxes need reconnecting.";
const graded = (message: string | null, against: WidgetCase) => ({
  leaks: leaks(message, against).length === 0 ? "pass" : "fail",
  rawFields: rawFields(message).length === 0 ? "pass" : "fail",
});

test("leak scan does not read a file extension as a domain", () => {
  assert.equal(
    graded("Choose a.CSV file, or export report.xlsx first.", recorded).leaks,
    "pass"
  );
  assert.equal(
    graded("Write to other-company.com first.", recorded).leaks,
    "fail"
  );
  // A domain-shaped stem is still a domain.
  assert.equal(
    graded("Open other-company.com.pdf first.", recorded).leaks,
    "fail"
  );
  // .zip is a real top-level domain, so a bare .zip name still needs ownership.
  assert.equal(
    graded("Download tenant-data.zip first.", recorded).leaks,
    "fail"
  );
});

test("leak scan passes the fixture workspace and fails foreign or internal text", () => {
  assert.equal(
    graded(
      "Open app.acquisity.ai/dashboard/aaron-fragas-workspace-wMUMT to check.",
      recorded
    ).leaks,
    "pass"
  );
  for (const message of [
    "Write to someone@other-company.com about it.",
    "Our Inngest job retried it.",
    "See https://acquisity.sentry.io/issues/1 for details.",
    "This is tracked in ENG-14665.",
    "Organization 9d4c2c1e-3f6a-4b8e-9b1a-0c2d3e4f5a6b is not yours.",
  ]) {
    assert.equal(graded(message, recorded).leaks, "fail", message);
  }
  assert.equal(graded(null, recorded).leaks, "pass");
});

test("answered lane comes from the run row", () => {
  const id = "run";
  assert.equal(
    answeredLane({ id, outcome: null, session_id: "wrun_x" }),
    "investigate"
  );
  assert.equal(
    answeredLane({ id, outcome: { reason: "chat" }, session_id: id }),
    "chat"
  );
  assert.equal(
    answeredLane({
      id,
      outcome: { reason: "asked_for_human" },
      session_id: id,
    }),
    "human"
  );
  assert.equal(
    answeredLane({ id, outcome: { reason: "kb_miss" }, session_id: id }),
    "kb"
  );
});

test("a bare URL scheme in prose is not a raw field, and a real one beside it still fails", () => {
  // Round 9, wrun ...YJJB31: forwarding steps said "(include https://)".
  const message =
    "Enter your website address as the Forwarding URL (include https://).";
  assert.equal(graded(message, recorded).rawFields, "pass");
  assert.equal(
    graded(`${message} The inbox shows status:error.`, recorded).rawFields,
    "fail"
  );
});

test("raw field names fail camelCase, key:value and JSON literals", () => {
  assert.equal(graded(REPLY, recorded).rawFields, "pass");
  for (const message of [
    "Your dailyLimit is reached.",
    "The inbox shows status:error.",
    "Warmup is false for two inboxes.",
  ]) {
    assert.equal(graded(message, recorded).rawFields, "fail", message);
  }
});

test("foreign identifiers listed in expectations fail even when present in the cassette", () => {
  const foreign = "00000000-0000-4000-8000-000000000001";
  const message = `Campaign ${foreign} is paused.`;
  assert.equal(graded(message, recorded).leaks, "pass");
  assert.equal(
    graded(message, expecting({ foreignIdentifiers: [foreign] })).leaks,
    "fail"
  );
});

test("raw-field checks cover quoted keys, spaced pairs and hyphen-adjacent camelCase", () => {
  for (const message of [
    '{"status": "error"}',
    "{status: error}",
    "dailyLimit: 30",
    "status_code: 500",
    "`status: error`",
    "dailyLimit-setting is reached.",
  ]) {
    assert.equal(graded(message, recorded).rawFields, "fail", message);
  }
  for (const message of [
    "Your campaign is paused. Open Campaign Options.",
    "What you can do: check the campaign status.",
    "Next step: open Settings.",
    "Note: reconnect your sending accounts.",
    "See https://help.acquisity.ai/campaigns for the steps.",
    "Open https://app.acquisity.ai/dashboard/aaron-fragas-workspace-wMUMT.",
  ]) {
    assert.equal(graded(message, recorded).rawFields, "pass", message);
  }
});

test("bold labels and merge tags are not raw fields; a real field still is", () => {
  for (const message of [
    "1. **Leads tab:** Make sure Leads Uploaded is above zero.",
    "Use {{sendingAccountFirstName}} in the signature, then click Save.",
  ]) {
    assert.equal(graded(message, recorded).rawFields, "pass", message);
  }
  for (const message of [
    "The record shows organization_id: 123.",
    "It saved sendingAccountId=abc.",
  ]) {
    assert.equal(graded(message, recorded).rawFields, "fail", message);
  }
});

test("bold raw keys and undocumented merge variables still fail the grader", () => {
  for (const message of [
    "**organization_id:** 123",
    "**sendingAccountId:** abc",
    "The internal field is {{sendingAccountId}}.",
  ]) {
    assert.equal(graded(message, recorded).rawFields, "fail", message);
  }
  for (const name of [
    "firstName",
    "lastName",
    "companyName",
    "industry",
    "jobTitle",
    "sendingAccountName",
    "sendingAccountFirstName",
  ]) {
    const message = `Use {{${name}}} in the email.`;
    assert.equal(graded(message, recorded).rawFields, "pass", message);
  }
  assert.equal(
    graded("**Leads tab:** Check uploaded leads.", recorded).rawFields,
    "pass"
  );
});

test("a handoff is the human lane or a reply held for a person, never a filed ticket", () => {
  assert.equal(handedOff("human", null), true);
  assert.equal(handedOff("investigate", "needs_human"), true);
  // A ticket filed with the reply allowed is not a person taking over.
  assert.equal(handedOff("investigate", "allow"), false);
});

test("leak scan owns the domain of an address in the evidence and what the customer wrote", () => {
  const evidence: WidgetCase = {
    ...recorded,
    cassette: [
      ...recorded.cassette,
      { ...recorded.cassette[0], output: "Sender\nsam@shop-one.co" },
    ],
    question: "A prospect asked who deals-two.com is.",
  };
  for (const message of [
    "The sam@shop-one.co inbox and other shop-one.co addresses are cancelled.",
    "Tell them deals-two.com is the address you send from.",
  ]) {
    assert.equal(graded(message, evidence).leaks, "pass", message);
  }
  assert.equal(
    graded("Write to other-company.com first.", evidence).leaks,
    "fail"
  );
});

test("Instantly may be named only when the case's own results show a connection the customer owns", () => {
  const owned = (accountType: string): WidgetCase => ({
    ...recorded,
    cassette: [
      ...recorded.cassette,
      {
        ...recorded.cassette[0],
        output: { connection: { accountType, isActive: true } },
      },
    ],
  });
  const message = "Your Instantly account rejected the connection.";
  // Legacy: the customer connected their own Instantly account.
  assert.equal(graded(message, owned("user_owned")).leaks, "pass");
  // Pro: provisioned for them, so the name stays hidden.
  assert.equal(graded(message, owned("system_provisioned")).leaks, "fail");
  assert.equal(graded(message, recorded).leaks, "fail");
});

test("a capitalized quoted UI label before a colon is not a raw key", () => {
  assert.equal(
    graded(
      'The help center lists three options under "Sites" > "Domains": a live URL or your own domain.',
      recorded
    ).rawFields,
    "pass"
  );
  assert.equal(graded('{"status": "error"}', recorded).rawFields, "fail");
});

test("a url in the workspace's own read owns its bare domain, and no other", () => {
  // Round 15 run 3 (wrun ...STAT0M): the order read had the forwarding target as a www url.
  const withForward: WidgetCase = {
    ...recorded,
    cassette: [
      ...recorded.cassette,
      {
        input: {},
        output: { forwardTo: "https://www.forward-target.example" },
        tool: "widget_provisioning_status",
      } as WidgetCase["cassette"][number],
    ],
  };
  const message = "Your order forwards to forward-target.example.";
  assert.equal(graded(message, recorded).leaks, "fail");
  assert.equal(graded(message, withForward).leaks, "pass");
  assert.equal(
    graded("It forwards to other-target.example.", withForward).leaks,
    "fail"
  );
});
