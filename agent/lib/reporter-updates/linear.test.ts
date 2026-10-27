import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commentIdFor } from "./comment-id.js";
import { linearPort } from "./linear.js";

const SANDBOX = "C0AAAAAAAAA";
const ASKS = { source: "linear-asks-bot" };
const COMMENT_ID = "00000000-0000-4000-8000-000000000001";
const PR = "https://github.com/Acquisity/Acquisity/pull/7";

const ok = (data: unknown) =>
  new Response(JSON.stringify({ data }), { status: 200 });

const NAMES: Record<string, string> = {
  aaron: "Aaron Fraga",
  james: "James Keeble",
  viewer: "Acquisity Foreman",
};

const comment = (
  id: string,
  body: string,
  over: {
    parent?: string | null;
    user?: string | null;
    createdAt?: string;
  } = {}
) => {
  const user = over.user === undefined ? "bot" : over.user;
  return {
    body,
    createdAt: over.createdAt ?? "2026-10-10T10:00:00Z",
    id,
    parent: over.parent ? { id: over.parent } : null,
    user: user && { id: user, name: NAMES[user] ?? `User ${user}` },
  };
};

const issue = (over: Record<string, unknown> = {}) => ({
  assignee: { name: "Sam Jones" },
  attachments: {
    nodes: [
      {
        metadata: ASKS,
        title: "Ask from A. Reporter",
        url: `https://x.slack.com/archives/${SANDBOX}/p1700000000000001`,
      },
      { title: "Fix", url: PR },
      { title: "Notes", url: "https://example.com/notes" },
    ],
  },
  comments: {
    nodes: [
      comment(
        "c-anchor",
        `Slack thread connected in [#sandbox](https://x.slack.com/archives/${SANDBOX}/p1700000000000001)`
      ),
      comment("c-1", "We've received your report", {
        parent: "c-anchor",
        user: "viewer",
      }),
      comment("c-2", "my own reply", { parent: "c-anchor", user: "reporter" }),
      comment("c-3", "elsewhere", { parent: "other", user: "viewer" }),
      comment("c-4", "Removed the wrong number from their contact.", {
        createdAt: "2026-10-12T10:00:00Z",
        user: "james",
      }),
      comment("c-5", "Triage notes from Foreman", { user: "viewer" }),
      comment("c-6", "Synced from an integration", { user: null }),
    ],
    pageInfo: { hasNextPage: false },
  },
  createdAt: "2026-10-10T09:00:00Z",
  description: "Exports stop at 500 rows.",
  id: "uuid-1",
  identifier: "ENG-1",
  labels: { nodes: [{ name: "Bug" }, { name: "Customer reported" }] },
  parent: {
    attachments: {
      nodes: [
        { title: "Fix", url: PR },
        {
          title: "Fix 2",
          url: "https://github.com/Acquisity/Acquisity/pull/8",
        },
      ],
    },
    identifier: "ENG-9",
    state: { type: "completed" },
  },
  relations: {
    nodes: [
      { relatedIssue: { identifier: "ENG-3" }, type: "related" },
      { relatedIssue: { identifier: "ENG-2" }, type: "duplicate" },
    ],
  },
  state: { name: "Done", type: "completed" },
  title: "Export is missing rows",
  ...over,
});

const portWith = (
  respond: (query: string, variables: Record<string, unknown>) => Response
) => {
  const requests: { query: string; variables: Record<string, unknown> }[] = [];
  const port = linearPort("token", (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    requests.push(body);
    return Promise.resolve(respond(body.query, body.variables));
  });
  return { port, requests };
};

describe("readTicket", () => {
  it("builds the facts, the thread anchor and Foreman's own comments under it", async () => {
    const { port } = portWith(() =>
      ok({ issue: issue(), viewer: { id: "viewer" } })
    );
    const view = await port.readTicket("ENG-1");
    assert.deepEqual(view?.facts, {
      assignee: "Sam Jones",
      channel: SANDBOX,
      closingComments: [
        {
          author: "foreman",
          body: "We've received your report",
          createdAt: "2026-10-10T10:00:00Z",
        },
        {
          author: "foreman",
          body: "elsewhere",
          createdAt: "2026-10-10T10:00:00Z",
        },
        {
          author: "foreman",
          body: "Triage notes from Foreman",
          createdAt: "2026-10-10T10:00:00Z",
        },
        {
          author: "staff",
          body: "Removed the wrong number from their contact.",
          createdAt: "2026-10-12T10:00:00Z",
        },
      ],
      createdAt: "2026-10-10T09:00:00Z",
      description: "Exports stop at 500 rows.",
      duplicateOf: "ENG-2",
      identifier: "ENG-1",
      labels: ["Bug", "Customer reported"],
      parent: { identifier: "ENG-9", stateType: "completed" },
      pullUrls: [PR, "https://github.com/Acquisity/Acquisity/pull/8"],
      stateName: "Done",
      stateType: "completed",
      title: "Export is missing rows",
    });
    assert.equal(view?.anchorId, "c-anchor");
    assert.equal(view?.issueId, "uuid-1");
    assert.deepEqual(view?.foremanComments, [
      { body: "We've received your report", id: "c-1" },
    ]);
  });

  it("falls back to the thread link when there is no Ask from link", async () => {
    const { port } = portWith(() =>
      ok({
        issue: issue({ attachments: { nodes: [] } }),
        viewer: { id: "viewer" },
      })
    );
    const view = await port.readTicket("ENG-1");
    assert.equal(view?.facts.channel, SANDBOX);
  });

  it("refuses a thread when the Ask link and the anchor name different channels", async () => {
    const { port } = portWith(() =>
      ok({
        issue: issue({
          comments: {
            nodes: [
              comment(
                "c-anchor",
                "Slack thread connected in [#other](https://x.slack.com/archives/C0ZZZZZZZZZ/p1700000000000001)"
              ),
            ],
            pageInfo: { hasNextPage: false },
          },
        }),
        viewer: { id: "viewer" },
      })
    );
    assert.equal((await port.readTicket("ENG-1"))?.facts.channel, null);
  });

  it("refuses a ticket whose Slack threads sit in two channels", async () => {
    const { port } = portWith(() =>
      ok({
        issue: issue({
          attachments: { nodes: [] },
          comments: {
            nodes: [
              comment(
                "a1",
                `Slack thread connected in [#a](https://x.slack.com/archives/${SANDBOX}/p1700000000000001)`,
                { createdAt: "2026-10-10T10:00:00Z" }
              ),
              comment(
                "a2",
                "Slack thread connected in [#b](https://x.slack.com/archives/C0ZZZZZZZZZ/p1700000000000002)",
                { createdAt: "2026-10-11T10:00:00Z" }
              ),
            ],
            pageInfo: { hasNextPage: false },
          },
        }),
        viewer: { id: "viewer" },
      })
    );
    assert.equal((await port.readTicket("ENG-1"))?.facts.channel, null);
  });

  it("names the channel when the Ask link and the anchor agree, and when a duplicate has lost its Ask link", async () => {
    const agree = portWith(() =>
      ok({
        issue: issue({
          comments: {
            nodes: [
              comment(
                "c-anchor",
                `Slack thread connected in [#a](https://x.slack.com/archives/${SANDBOX}/p1700000000000001)`
              ),
            ],
            pageInfo: { hasNextPage: false },
          },
        }),
        viewer: { id: "viewer" },
      })
    );
    const duplicate = portWith(() =>
      ok({
        issue: issue({
          attachments: { nodes: [] },
          comments: {
            nodes: [
              comment(
                "c-anchor",
                `Slack thread connected in [#a](https://x.slack.com/archives/${SANDBOX}/p1700000000000001)`
              ),
            ],
            pageInfo: { hasNextPage: false },
          },
        }),
        viewer: { id: "viewer" },
      })
    );
    assert.equal(
      (await agree.port.readTicket("ENG-1"))?.facts.channel,
      SANDBOX
    );
    assert.equal(
      (await duplicate.port.readTicket("ENG-1"))?.facts.channel,
      SANDBOX
    );
  });

  describe("where the receiver would deliver", () => {
    const own = {
      metadata: ASKS,
      title: "Ask from A. Reporter",
      url: `https://x.slack.com/archives/${SANDBOX}/p1700000000000001`,
    };
    const moved = {
      metadata: ASKS,
      title: "Ask from B. Reporter",
      url: "https://x.slack.com/archives/C0YYYYYYYYY/p1700000000000009",
    };
    const readWith = (nodes: unknown[]) =>
      portWith(() =>
        ok({
          issue: issue({ attachments: { nodes } }),
          viewer: { id: "viewer" },
        })
      ).port.readTicket("ENG-1");

    it("delivers to the owned thread when the owned Ask link comes first, whatever follows it", async () => {
      const view = await readWith([own, moved]);
      assert.equal(view?.facts.channel, SANDBOX);
      assert.equal(view?.undeliverable, null);
    });

    it("delivers nowhere when the first Ask link is a thread moved in from another ticket", async () => {
      const view = await readWith([moved, own]);
      assert.equal(view?.facts.channel, null);
      assert.deepEqual(view?.undeliverable, ["C0YYYYYYYYY", SANDBOX]);
    });

    it("delivers nowhere when the only Ask link belongs to a thread this ticket does not own", async () => {
      const view = await readWith([moved]);
      assert.equal(view?.facts.channel, null);
      assert.ok(view?.undeliverable);
    });

    it("ignores an attachment the Asks bot did not create", async () => {
      const view = await readWith([
        { ...moved, metadata: { source: "someone-else" } },
        own,
      ]);
      assert.equal(view?.facts.channel, SANDBOX);
      assert.equal(view?.undeliverable, null);
    });

    it("skips an Ask link that is not a Slack thread and uses the next one", async () => {
      const view = await readWith([
        { ...moved, url: "https://example.com/not-slack" },
        own,
      ]);
      assert.equal(view?.facts.channel, SANDBOX);
    });
  });

  it("writes under the exact anchor whose channel was checked, not under an older one", async () => {
    const { port } = portWith(() =>
      ok({
        issue: issue({
          attachments: {
            nodes: [
              {
                metadata: ASKS,
                title: "Ask from B. Reporter",
                url: "https://x.slack.com/archives/C0YYYYYYYYY/p1700000000000009",
              },
            ],
          },
          comments: {
            nodes: [
              comment(
                "anchor-a",
                `Slack thread connected in [#a](https://x.slack.com/archives/${SANDBOX}/p1700000000000001)`,
                { createdAt: "2026-10-10T10:00:00Z" }
              ),
              comment(
                "anchor-b",
                "Slack thread connected in [#b](https://x.slack.com/archives/C0YYYYYYYYY/p1700000000000009)",
                { createdAt: "2026-10-11T10:00:00Z" }
              ),
              comment("f1", "We looked into this", {
                parent: "anchor-b",
                user: "viewer",
              }),
            ],
            pageInfo: { hasNextPage: false },
          },
        }),
        viewer: { id: "viewer" },
      })
    );
    const view = await port.readTicket("ENG-1");
    assert.equal(view?.facts.channel, "C0YYYYYYYYY");
    assert.equal(view?.anchorId, "anchor-b");
    assert.deepEqual(
      view?.foremanComments.map((c) => c.id),
      ["f1"]
    );
  });

  it("refuses a ticket whose only Ask links belong to threads it does not own", async () => {
    const { port } = portWith(() =>
      ok({
        issue: issue({
          attachments: {
            nodes: [
              {
                metadata: ASKS,
                title: "Ask from B. Reporter",
                url: `https://x.slack.com/archives/${SANDBOX}/p1700000000000009`,
              },
            ],
          },
        }),
        viewer: { id: "viewer" },
      })
    );
    assert.equal((await port.readTicket("ENG-1"))?.facts.channel, null);
  });

  it("matches an owned thread to its Ask link even when the anchor link carries a query string", async () => {
    const { port } = portWith(() =>
      ok({
        issue: issue({
          comments: {
            nodes: [
              comment(
                "c-anchor",
                `Slack thread connected in [#a](https://x.slack.com/archives/${SANDBOX}/p1700000000000001?thread_ts=1.2&cid=${SANDBOX})`
              ),
            ],
            pageInfo: { hasNextPage: false },
          },
        }),
        viewer: { id: "viewer" },
      })
    );
    assert.equal((await port.readTicket("ENG-1"))?.facts.channel, SANDBOX);
  });

  it("does not treat a support inbox note as a reporter thread", async () => {
    const { port } = portWith(() =>
      ok({
        issue: issue({
          comments: {
            nodes: [
              comment(
                "n",
                "Support conversation connected in [inbox](https://example.com/c/1)"
              ),
            ],
            pageInfo: { hasNextPage: false },
          },
        }),
        viewer: { id: "viewer" },
      })
    );
    assert.equal((await port.readTicket("ENG-1"))?.anchorId, null);
  });

  it("uses the earliest Slack thread when a ticket has more than one", async () => {
    const { port } = portWith(() =>
      ok({
        issue: issue({
          comments: {
            nodes: [
              comment(
                "late",
                "Slack thread connected in [#a](https://x.slack.com/archives/C0YYYYYYYYY/p1700000000000002)",
                { createdAt: "2026-10-12T10:00:00Z" }
              ),
              comment(
                "early",
                "Slack thread connected in [#a](https://x.slack.com/archives/C0YYYYYYYYY/p1700000000000001)",
                { createdAt: "2026-10-11T10:00:00Z" }
              ),
            ],
            pageInfo: { hasNextPage: false },
          },
        }),
        viewer: { id: "viewer" },
      })
    );
    assert.equal((await port.readTicket("ENG-1"))?.anchorId, "early");
  });

  it("returns null for a missing ticket and refuses a thread it cannot read in full", async () => {
    const missing = portWith(() =>
      ok({ issue: null, viewer: { id: "viewer" } })
    );
    assert.equal(await missing.port.readTicket("ENG-1"), null);
    const long = portWith(() =>
      ok({
        issue: issue({
          comments: { nodes: [], pageInfo: { hasNextPage: true } },
        }),
        viewer: { id: "viewer" },
      })
    );
    await assert.rejects(long.port.readTicket("ENG-1"), {
      name: "ThreadIncompleteError",
    });
  });
});

describe("closing comments", () => {
  const BOT_ANCHOR = comment(
    "c-anchor",
    `Slack thread connected in [#sandbox](https://x.slack.com/archives/${SANDBOX}/p1700000000000001)`,
    { user: null }
  );
  const at = (minute: number) =>
    `2026-10-12T10:${String(minute).padStart(2, "0")}:00Z`;
  const read = async (nodes: ReturnType<typeof comment>[]) => {
    const { port } = portWith(() =>
      ok({
        issue: issue({
          comments: {
            nodes: [BOT_ANCHOR, ...nodes],
            pageInfo: { hasNextPage: false },
          },
        }),
        viewer: { id: "viewer" },
      })
    );
    return (await port.readTicket("ENG-1"))?.facts.closingComments ?? [];
  };

  it("counts staff replies in the Linear-bot Slack thread and in a staff-started thread, and nobody else's", async () => {
    const found = await read([
      comment("a-1", "Looking at this now.", {
        createdAt: at(1),
        parent: "c-anchor",
        user: "aaron",
      }),
      comment("f-1", "This works as designed.", {
        createdAt: at(2),
        parent: "c-anchor",
        user: "viewer",
      }),
      comment("r-1", "It is still wrong for me.", {
        createdAt: at(3),
        parent: "c-anchor",
        user: "reporter",
      }),
      comment(commentIdFor("ENG-1", "received"), "Thanks, got it.", {
        createdAt: at(4),
        parent: "c-anchor",
        user: "viewer",
      }),
      comment("t-1", "Removing the wrong number.", {
        createdAt: at(5),
        user: "aaron",
      }),
      comment("t-2", "Removed it from the CRM.", {
        createdAt: at(6),
        parent: "t-1",
        user: "aaron",
      }),
      comment("t-3", "Thanks.", {
        createdAt: at(7),
        parent: "t-1",
        user: "outsider",
      }),
      comment("b-1", "Synced by an integration.", {
        createdAt: at(8),
        user: null,
      }),
    ]);
    assert.deepEqual(
      found.map((c) => [c.author, c.body]),
      [
        ["staff", "Looking at this now."],
        ["foreman", "This works as designed."],
        ["staff", "Removing the wrong number."],
        ["staff", "Removed it from the CRM."],
      ]
    );
  });

  it("keeps a staff comment even when many Foreman notes follow it, and caps each group", async () => {
    const found = await read([
      comment("a-1", "Fixed their data.", { createdAt: at(1), user: "aaron" }),
      ...Array.from({ length: 7 }, (_, i) =>
        comment(`f-${i}`, `Foreman note ${i}`, {
          createdAt: at(10 + i),
          user: "viewer",
        })
      ),
    ]);
    assert.deepEqual(
      found.filter((c) => c.author === "staff").map((c) => c.body),
      ["Fixed their data."]
    );
    assert.deepEqual(
      found.filter((c) => c.author === "foreman").map((c) => c.body),
      [
        "Foreman note 2",
        "Foreman note 3",
        "Foreman note 4",
        "Foreman note 5",
        "Foreman note 6",
      ]
    );
  });
});

describe("readOriginal", () => {
  it("reads state, labels and linked pull requests without loading comments, so a long thread cannot block it", async () => {
    const { port, requests } = portWith(() =>
      ok({
        issue: {
          assignee: null,
          attachments: { nodes: [{ title: "Fix", url: PR }] },
          description: null,
          identifier: "ENG-9",
          labels: { nodes: [{ name: "Feature Request" }] },
          parent: null,
          state: { name: "Done", type: "completed" },
          title: "Email from the dialler",
        },
      })
    );
    const facts = await port.readOriginal("ENG-9");
    assert.ok(!requests[0]?.query.includes("comments"));
    assert.deepEqual(
      facts && {
        labels: facts.labels,
        pullUrls: facts.pullUrls,
        stateType: facts.stateType,
        title: facts.title,
      },
      {
        labels: ["Feature Request"],
        pullUrls: [PR],
        stateType: "completed",
        title: "Email from the dialler",
      }
    );
  });

  it("returns null for a missing original", async () => {
    const { port } = portWith(() => ok({ issue: null }));
    assert.equal(await port.readOriginal("ENG-9"), null);
  });
});

describe("postUnderAnchor", () => {
  it("writes the message under the thread anchor and returns the new comment id", async () => {
    const { port, requests } = portWith(() =>
      ok({ commentCreate: { comment: { id: "new" }, success: true } })
    );
    assert.equal(
      await port.postUnderAnchor("uuid-1", "c-anchor", "Hello", COMMENT_ID),
      "new"
    );
    assert.deepEqual(requests[0]?.variables, {
      input: {
        body: "Hello",
        id: COMMENT_ID,
        issueId: "uuid-1",
        parentId: "c-anchor",
      },
    });
  });

  it("fails when Linear does not confirm the comment", async () => {
    const { port } = portWith(() =>
      ok({ commentCreate: { comment: null, success: false } })
    );
    await assert.rejects(
      port.postUnderAnchor("uuid-1", "c-anchor", "Hello", COMMENT_ID),
      {
        message: "Linear did not create the reply.",
      }
    );
  });
});

describe("discover", () => {
  const page = (identifier: string, next: string | null) =>
    ok({
      issues: {
        nodes: [
          { identifier, parent: null, updatedAt: "2026-10-12T10:00:00Z" },
        ],
        pageInfo: { endCursor: next, hasNextPage: next !== null },
      },
    });
  const SINCE = "2026-10-10T00:00:00.000Z";
  const CREATED = "2026-10-01T00:00:00.000Z";

  it("follows the cursor across pages and reports the list as finished", async () => {
    const { port, requests } = portWith((_query, variables) =>
      variables.after === null ? page("ENG-1", "next") : page("ENG-2", null)
    );
    assert.deepEqual(await port.discover(SINCE, CREATED, null), {
      next: null,
      tickets: [
        { issue: "ENG-1", version: Date.parse("2026-10-12T10:00:00Z") },
        { issue: "ENG-2", version: Date.parse("2026-10-12T10:00:00Z") },
      ],
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.variables.since, SINCE);
    assert.equal(requests[0]?.variables.created, CREATED);
  });

  it("starts from the page cursor it is given", async () => {
    const { port, requests } = portWith(() => page("ENG-9", null));
    await port.discover(SINCE, CREATED, "resume-here");
    assert.equal(requests[0]?.variables.after, "resume-here");
  });

  it("asks for tickets with a Slack thread anchor, never for an Ask link, in a stable order", async () => {
    const { port, requests } = portWith(() => page("ENG-1", null));
    await port.discover(SINCE, CREATED, null);
    const query = requests[0]?.query ?? "";
    assert.equal(requests[0]?.variables.anchor, "Slack thread connected in ");
    assert.ok(
      query.includes("comments: { some: { body: { startsWith: $anchor } } }")
    );
    assert.ok(query.includes("orderBy: createdAt"));
    assert.ok(!query.includes("attachments"));
    assert.ok(!query.includes("Ask from"));
  });

  it("also asks for tickets whose master changed, so a master closing finds its unchanged reports", async () => {
    const { port, requests } = portWith(() => page("ENG-1", null));
    await port.discover(SINCE, CREATED, null);
    const query = requests[0]?.query ?? "";
    assert.ok(query.includes("{ parent: { updatedAt: { gt: $since } } }"));
    assert.ok(query.includes("createdAt: { gt: $created }"));
  });

  it("hands back the page cursor when there are more tickets than one run will list", async () => {
    let n = 0;
    const { port } = portWith(() => {
      n += 1;
      return page(`ENG-${n}`, `cursor-${n}`);
    });
    const found = await port.discover(SINCE, CREATED, null);
    assert.equal(found.next, "cursor-20");
    assert.equal(found.tickets.length, 20);
  });
});

describe("deadline", () => {
  it("gives up on a Linear request that never answers", async () => {
    const hung = linearPort(
      "token",
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        }),
      40
    );
    await assert.rejects(hung.readTicket("ENG-1"), { message: "aborted" });
    await assert.rejects(
      hung.postUnderAnchor("uuid-1", "c-anchor", "Hello", COMMENT_ID),
      {
        message: "aborted",
      }
    );
  });
});
