import assert from "node:assert/strict";
import { test } from "node:test";
import { readAskFrom } from "./requester-reply.js";
import { widgetContextSchema } from "./widget-scope.js";
import {
  isWidgetFiledDescription,
  WIDGET_SCOPE_NOTICE,
} from "./widget-ticket-marker.js";

interface OldScope {
  conversationId: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
}

/** The block every widget ticket's description ended with before ENG-21100; old tickets still carry it. */
const widgetScopeBlock = (old: OldScope) =>
  `## Verified scope\n\n- Workspace: ${old.organizationName} (${old.organizationSlug})\n- Organization ID: ${old.organizationId}\n- Support conversation: ${old.conversationId}\n\n${WIDGET_SCOPE_NOTICE}`;

const scope: OldScope = {
  conversationId: "conv-1",
  organizationId: "org-1",
  organizationName: "Trivox AI",
  organizationSlug: "trivox",
};

const filed = `The customer cannot add inboxes.\n\n${widgetScopeBlock(scope)}`;

test("a ticket ending in the widget's verified scope block is widget-filed", () => {
  assert.equal(isWidgetFiledDescription(filed), true);
  assert.equal(isWidgetFiledDescription(`${filed}\n`), true);
  assert.equal(isWidgetFiledDescription(widgetScopeBlock(scope)), true);
});

test("the description Linear returns, with its bullets rewritten, still counts", () => {
  const stored = filed.replaceAll("\n- ", "\n* ");
  assert.notEqual(stored, filed);
  assert.equal(isWidgetFiledDescription(stored), true);
  assert.equal(
    isWidgetFiledDescription(
      stored.replace("Support conversation", "Intercom conversation")
    ),
    true
  );
});

test("an ordinary ticket, a quoted notice or a block with text after it is not", () => {
  assert.equal(isWidgetFiledDescription(null), false);
  assert.equal(
    isWidgetFiledDescription("The customer cannot add inboxes."),
    false
  );
  assert.equal(isWidgetFiledDescription(WIDGET_SCOPE_NOTICE), false);
  assert.equal(
    isWidgetFiledDescription(`Customer wrote: ${WIDGET_SCOPE_NOTICE}`),
    false
  );
  assert.equal(
    isWidgetFiledDescription(`${filed}\n\nPlease look at this today.`),
    false
  );
  assert.equal(
    isWidgetFiledDescription(
      `${filed.replace("- Organization ID: org-1\n", "")}`
    ),
    false
  );
});

const linearReturning = (
  description: string | null,
  attachments: { title: string; url: string }[] = [],
  documents: { content: string | null; title: string }[] = [],
  project: string | null = null,
  /** Reads after the first answer, when a report lands after the session opens. */
  later: { content: string | null; title: string }[][] = []
) => {
  let reads = 0;
  return {
    fetch: (() => {
      const shown = reads === 0 ? documents : (later[reads - 1] ?? documents);
      reads += 1;
      return Promise.resolve(
        Response.json({
          data: {
            issue: {
              attachments: { nodes: attachments },
              description,
              documents: { nodes: shown },
              project: project ? { id: project } : null,
            },
          },
        })
      );
    }) as typeof fetch,
    reads: () => reads,
  };
};

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const chatLink = (title = "Support chat") => ({
  title,
  url: `https://app.acquisity.ai/dashboard/admin/support?conversation=${CONVERSATION}`,
});
/** A Support report as Linear returns it, with its bullets rewritten. */
const supportReport = {
  content: `## Verified scope\n\n* Workspace: Trivox AI (trivox)\n* Workspace ID: 22222222-2222-4222-8222-222222222222\n* Support conversation: ${CONVERSATION}\n\n${WIDGET_SCOPE_NOTICE}\n\n## Conversation (oldest first)\n\n* Customer: Inboxes fail.`,
  title: "Support report",
};

const credentials = { accessToken: "token" };
const thread = (channel: string) =>
  `https://fegrowthpartner.slack.com/archives/${channel}/p1791000000000100`;

test("the intake read marks widget-filed, support-conversation and migration-form tickets as triage intake", async () => {
  const cases: [
    string,
    Awaited<ReturnType<typeof readAskFrom>>["triageIntake"],
    string | null,
    { title: string; url: string }[],
  ][] = [
    ["widget-filed before ENG-21100", true, filed, []],
    ["linked to its support chat", true, "Inboxes fail.", [chatLink()]],
    [
      "linked from the support inbox by a teammate",
      false,
      "Inboxes fail.",
      [chatLink("Support conversation · someone")],
    ],
    [
      "CRM form",
      true,
      "A report",
      [{ title: "Ask from Dana Lee", url: thread("C0C8XP8HAFL") }],
    ],
    [
      "developer channel",
      false,
      "A report",
      [{ title: "Ask from Dana Lee", url: thread("C0BLFDUN6Q7") }],
    ],
    ["plain ticket", false, "A report", []],
  ];
  const reads = await Promise.all(
    cases.map(([, , description, attachments]) =>
      readAskFrom(
        "issue-1",
        credentials,
        linearReturning(description, attachments),
        []
      )
    )
  );
  cases.forEach(([name, expected], index) => {
    assert.equal(reads[index].triageIntake, expected, name);
  });
});

test("the longest workspace line the scope block can write still counts", () => {
  const longest = {
    ...scope,
    organizationName: "N".repeat(500),
    organizationSlug: `s${"x".repeat(199)}`,
  };
  assert.equal(
    widgetContextSchema.shape.organizationName.safeParse(
      longest.organizationName
    ).success,
    true
  );
  assert.equal(
    widgetContextSchema.shape.organizationSlug.safeParse(
      longest.organizationSlug
    ).success,
    true
  );
  assert.equal(
    isWidgetFiledDescription(`Inboxes fail.\n\n${widgetScopeBlock(longest)}`),
    true
  );
});

test("a widget ticket's verified scope comes from its Support report, only when Foreman linked it to the chat", async () => {
  const linked = await readAskFrom(
    "issue-1",
    credentials,
    linearReturning("Inboxes fail.", [chatLink()], [supportReport])
  );
  assert.equal(
    linked.supportScope,
    `- Workspace: Trivox AI (trivox)\n- Workspace ID: 22222222-2222-4222-8222-222222222222\n- Support conversation: ${CONVERSATION}`
  );
  const unlinked = await readAskFrom(
    "issue-1",
    credentials,
    linearReturning("Inboxes fail.", [], [supportReport]),
    []
  );
  assert.equal(unlinked.supportScope, null);
  const old = await readAskFrom(
    "issue-1",
    credentials,
    linearReturning(filed),
    []
  );
  assert.equal(old.supportScope, null);
  assert.equal(old.triageIntake, true);
});

test("a session that opens before the Support report lands waits for it", async () => {
  const body =
    "Inboxes fail.\n\nThe conversation, the verified workspace and the ids are in the Support report document attached to this ticket.";
  const api = linearReturning(body, [chatLink()], [], null, [
    [],
    [supportReport],
  ]);
  const ask = await readAskFrom("issue-1", credentials, api, [1, 1]);
  assert.equal(api.reads(), 3);
  assert.ok(
    ask.supportScope?.includes(
      "- Workspace ID: 22222222-2222-4222-8222-222222222222"
    )
  );
  // Any other ticket, linked or not, never waits.
  const plain = linearReturning("A report", [chatLink()]);
  await readAskFrom("issue-1", credentials, plain, [1, 1]);
  assert.equal(plain.reads(), 1);
});

test("the longest workspace line still yields the Workspace ID", async () => {
  // Every opening angle bracket is escaped to four characters in the report.
  const name = "&lt;".repeat(500);
  const report = {
    content: supportReport.content.replace(
      "Trivox AI (trivox)",
      `${name} (s${"x".repeat(199)})`
    ),
    title: "Support report",
  };
  const ask = await readAskFrom(
    "issue-1",
    credentials,
    linearReturning("Inboxes fail.", [chatLink()], [report]),
    []
  );
  assert.ok(
    ask.supportScope?.includes(
      "- Workspace ID: 22222222-2222-4222-8222-222222222222"
    )
  );
});

test("a customer's report on a Foreman reply is linked to the chat but is not triage intake", async () => {
  const ask = await readAskFrom(
    "issue-1",
    credentials,
    linearReturning(
      "Wrong answer.",
      [chatLink()],
      [supportReport],
      "84ab288a-6a7b-4316-ab6f-f67809a40211"
    ),
    []
  );
  assert.equal(ask.triageIntake, false);
});
