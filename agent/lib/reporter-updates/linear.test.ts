import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { linearPort } from "./linear.js";

const SANDBOX = "C0AAAAAAAAA";
const COMMENT_ID = "00000000-0000-4000-8000-000000000001";
const PR = "https://github.com/Acquisity/Acquisity/pull/7";

const ok = (data: unknown) =>
  new Response(JSON.stringify({ data }), { status: 200 });

const comment = (
  id: string,
  body: string,
  over: {
    parent?: string | null;
    user?: string | null;
    createdAt?: string;
  } = {}
) => ({
  body,
  createdAt: over.createdAt ?? "2026-10-10T10:00:00Z",
  id,
  parent: over.parent ? { id: over.parent } : null,
  user:
    over.user === undefined ? { id: "bot" } : over.user && { id: over.user },
});

const issue = (over: Record<string, unknown> = {}) => ({
  assignee: { name: "Sam Jones" },
  attachments: {
    nodes: [
      {
        title: "Ask from A. Reporter",
        url: `https://x.slack.com/archives/${SANDBOX}/p1`,
      },
      { title: "Fix", url: PR },
      { title: "Notes", url: "https://example.com/notes" },
    ],
  },
  comments: {
    nodes: [
      comment(
        "c-anchor",
        `Slack thread connected in [#sandbox](https://x.slack.com/archives/${SANDBOX}/p1)`
      ),
      comment("c-1", "We've received your report", {
        parent: "c-anchor",
        user: "viewer",
      }),
      comment("c-2", "my own reply", { parent: "c-anchor", user: "reporter" }),
      comment("c-3", "elsewhere", { parent: "other", user: "viewer" }),
    ],
    pageInfo: { hasNextPage: false },
  },
  createdAt: "2026-10-10T09:00:00Z",
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
  state: { name: "Done", type: "completed" },
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
      createdAt: "2026-10-10T09:00:00Z",
      identifier: "ENG-1",
      labels: ["Bug", "Customer reported"],
      parent: { identifier: "ENG-9", stateType: "completed" },
      pullUrls: [PR, "https://github.com/Acquisity/Acquisity/pull/8"],
      stateName: "Done",
      stateType: "completed",
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
                "Slack thread connected in [#other](https://x.slack.com/archives/C0ZZZZZZZZZ/p1)"
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
                `Slack thread connected in [#a](https://x.slack.com/archives/${SANDBOX}/p1)`,
                { createdAt: "2026-10-10T10:00:00Z" }
              ),
              comment(
                "a2",
                "Slack thread connected in [#b](https://x.slack.com/archives/C0ZZZZZZZZZ/p2)",
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
                `Slack thread connected in [#a](https://x.slack.com/archives/${SANDBOX}/p1)`
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
                `Slack thread connected in [#a](https://x.slack.com/archives/${SANDBOX}/p1)`
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

  it("posts into the owned thread when a duplicate's Ask link has moved onto this ticket from another channel", async () => {
    const withMoved = (movedFirst: boolean) => {
      const own = {
        title: "Ask from A. Reporter",
        url: `https://x.slack.com/archives/${SANDBOX}/p1`,
      };
      const moved = {
        title: "Ask from B. Reporter",
        url: "https://x.slack.com/archives/C0YYYYYYYYY/p9",
      };
      return portWith(() =>
        ok({
          issue: issue({
            attachments: { nodes: movedFirst ? [moved, own] : [own, moved] },
          }),
          viewer: { id: "viewer" },
        })
      );
    };
    assert.equal(
      (await withMoved(false).port.readTicket("ENG-1"))?.facts.channel,
      SANDBOX
    );
    assert.equal(
      (await withMoved(true).port.readTicket("ENG-1"))?.facts.channel,
      SANDBOX
    );
  });

  it("refuses a ticket whose only Ask links belong to threads it does not own", async () => {
    const { port } = portWith(() =>
      ok({
        issue: issue({
          attachments: {
            nodes: [
              {
                title: "Ask from B. Reporter",
                url: `https://x.slack.com/archives/${SANDBOX}/p9`,
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
                `Slack thread connected in [#a](https://x.slack.com/archives/${SANDBOX}/p1?thread_ts=1.2&cid=${SANDBOX})`
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
                "Slack thread connected in [#a](https://x.slack.com/archives/C0YYYYYYYYY/p2)",
                { createdAt: "2026-10-12T10:00:00Z" }
              ),
              comment(
                "early",
                "Slack thread connected in [#a](https://x.slack.com/archives/C0YYYYYYYYY/p1)",
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
        nodes: [{ identifier }],
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
      identifiers: ["ENG-1", "ENG-2"],
      next: null,
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
    assert.equal(found.identifiers.length, 20);
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
