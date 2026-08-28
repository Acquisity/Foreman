import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ENGINEERING_TEAM_ID,
  findRelatedIssues,
  linearGraphql,
  saveInvestigationDocument,
} from "./linear-api.js";

const WAS_WRITTEN = /was written/u;

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
      status,
    })
  );

const node = (id: string) => ({
  assignee: null,
  createdAt: "2026-08-20T00:00:00.000Z",
  id,
  identifier: `ENG-${id}`,
  labels: { nodes: [{ name: "Bug" }] },
  parent: null,
  state: { name: "Todo", type: "unstarted" },
  title: `Issue ${id}`,
  url: `https://linear.app/acquisity/issue/ENG-${id}`,
});

const page = (ids: string[], endCursor: string | null) => ({
  data: {
    issues: {
      nodes: ids.map(node),
      pageInfo: { endCursor, hasNextPage: endCursor !== null },
    },
  },
});

describe("linearGraphql", () => {
  it("sends a bearer header and turns GraphQL errors into a thrown message", async () => {
    let header = "";
    const fetchStub: typeof fetch = (_url, init) => {
      header = new Headers(init?.headers).get("Authorization") ?? "";
      return json({ errors: [{ message: "Field nope not found" }] });
    };
    await assert.rejects(
      linearGraphql("secret-token", "{ x }", {}, { fetch: fetchStub }),
      (error: Error) =>
        error.message.includes("Field nope not found") &&
        !error.message.includes("secret-token")
    );
    assert.equal(header, "Bearer secret-token");
  });
});

describe("findRelatedIssues", () => {
  it("paginates masters until hasNextPage is false, windowed to the team", async () => {
    const variables: Record<string, unknown>[] = [];
    const fetchStub: typeof fetch = (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        variables: Record<string, unknown>;
      };
      variables.push(body.variables);
      return body.variables.after === null
        ? json(page(["1", "2"], "c1"))
        : json(page(["3"], null));
    };
    const result = await findRelatedIssues(
      "t",
      { phrases: ["billed twice"], scope: "masters", windowed: true },
      { fetch: fetchStub, now: new Date("2026-08-31T00:00:00.000Z") }
    );
    assert.equal(variables.length, 2);
    assert.equal(variables[1]?.after, "c1");
    assert.equal(variables[0]?.includeArchived, false);
    const filter = variables[0]?.filter as Record<string, unknown>;
    assert.deepEqual(filter.team, { id: { eq: ENGINEERING_TEAM_ID } });
    assert.deepEqual(filter.createdAt, { gte: "2026-08-01T00:00:00.000Z" });
    assert.equal(result.createdAfter, "2026-08-01T00:00:00.000Z");
    assert.deepEqual(
      result.issues.map((issue) => issue.identifier),
      ["ENG-1", "ENG-2", "ENG-3"]
    );
    assert.equal(result.truncated, false);
  });

  it("leaves masters unbounded when not windowed", async () => {
    const filters: Record<string, unknown>[] = [];
    const fetchStub: typeof fetch = (_url, init) => {
      const { variables } = JSON.parse(String(init?.body)) as {
        variables: { filter: Record<string, unknown> };
      };
      filters.push(variables.filter);
      return json(page([], null));
    };
    const result = await findRelatedIssues(
      "t",
      { phrases: ["x"], scope: "masters", windowed: false },
      { fetch: fetchStub }
    );
    assert.equal(filters[0]?.createdAt, undefined);
    assert.equal(result.createdAfter, null);
  });

  it("requires every word of a phrase, each in title or description", async () => {
    let filter: Record<string, unknown> | undefined;
    const fetchStub: typeof fetch = (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        variables: { filter: Record<string, unknown> };
      };
      ({ filter } = body.variables);
      return json({
        data: { issues: { nodes: [], pageInfo: { hasNextPage: false } } },
      });
    };
    await findRelatedIssues(
      "t",
      { phrases: ["empty  sections"], scope: "duplicates", windowed: false },
      { fetch: fetchStub }
    );
    assert.deepEqual(filter, {
      and: [
        {
          or: [
            { title: { containsIgnoreCase: "empty" } },
            { description: { containsIgnoreCase: "empty" } },
          ],
        },
        {
          or: [
            { title: { containsIgnoreCase: "sections" } },
            { description: { containsIgnoreCase: "sections" } },
          ],
        },
      ],
    });
  });

  it("runs a repeated phrase once", async () => {
    let calls = 0;
    const result = await findRelatedIssues(
      "t",
      { phrases: ["same", "same"], scope: "duplicates", windowed: false },
      {
        fetch: () => {
          calls += 1;
          return json(page(["1"], null));
        },
      }
    );
    assert.equal(calls, 1);
    assert.deepEqual(result.issues[0]?.matchedPhrases, ["same"]);
  });

  it("stops masters at the page cap and flags it", async () => {
    let calls = 0;
    const result = await findRelatedIssues(
      "t",
      { phrases: ["x"], scope: "masters", windowed: false },
      {
        fetch: () => {
          calls += 1;
          return json(page([String(calls)], `c${calls}`));
        },
      }
    );
    assert.equal(calls, 20);
    assert.equal(result.truncated, true);
  });

  it("caps the merged result at 100 issues and flags it", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => String(i));
    const result = await findRelatedIssues(
      "t",
      { phrases: ["x"], scope: "masters", windowed: false },
      { fetch: () => json(page(ids, null)) }
    );
    assert.equal(result.issues.length, 100);
    assert.equal(result.truncated, true);
  });

  it("dedupes duplicates across phrases, includes archived, and flags a second page", async () => {
    let calls = 0;
    const fetchStub: typeof fetch = (_url, init) => {
      calls += 1;
      const { variables } = JSON.parse(String(init?.body)) as {
        variables: { includeArchived: boolean };
      };
      assert.equal(variables.includeArchived, true);
      return calls === 1
        ? json(page(["1", "2"], null))
        : json(page(["2", "3"], "more"));
    };
    const result = await findRelatedIssues(
      "t",
      {
        phrases: ["billed twice", "double charge"],
        scope: "duplicates",
        windowed: true,
      },
      { fetch: fetchStub }
    );
    assert.equal(calls, 2);
    assert.equal(result.createdAfter, null);
    assert.deepEqual(
      result.issues.map((issue) => [issue.identifier, issue.matchedPhrases]),
      [
        ["ENG-1", ["billed twice"]],
        ["ENG-2", ["billed twice", "double charge"]],
        ["ENG-3", ["double charge"]],
      ]
    );
    assert.equal(result.truncated, true);
  });
});

describe("saveInvestigationDocument", () => {
  const document = {
    id: "doc1",
    updatedAt: "2026-08-27T10:00:00.000Z",
    url: "https://linear.app/d/doc1",
  };
  const respond = (existingTitle: string | null) => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> =
      [];
    const fetchStub: typeof fetch = (_url, init) => {
      const body = JSON.parse(String(init?.body)) as (typeof calls)[number];
      calls.push(body);
      if (body.query.startsWith("query IssueDocuments")) {
        return json({
          data: {
            issue: {
              documents: {
                nodes: existingTitle
                  ? [{ id: "doc1", title: existingTitle }]
                  : [],
              },
              id: "issue-uuid",
            },
          },
        });
      }
      if (body.query.startsWith("query Document")) {
        return json({
          data: {
            document: { ...document, updatedAt: "2026-08-27T10:00:05.000Z" },
          },
        });
      }
      if (body.query.startsWith("mutation CreateDocument")) {
        return json({ data: { documentCreate: { document, success: true } } });
      }
      return json({ data: { documentUpdate: { document, success: true } } });
    };
    return { calls, fetchStub };
  };

  it("creates the lane's document when the issue has none with that title", async () => {
    const { calls, fetchStub } = respond("Some other doc");
    const result = await saveInvestigationDocument(
      "t",
      { content: "# Triage investigation", issue: "ENG-1", lane: "triage" },
      { fetch: fetchStub }
    );
    assert.equal(result.created, true);
    // The mutation payload reports the pre-write timestamp; the pin comes from the read-back.
    assert.equal(result.updatedAt, "2026-08-27T10:00:05.000Z");
    assert.ok(calls[2]?.query.startsWith("query Document"));
    assert.equal(calls[2]?.variables.id, "doc1");
    assert.deepEqual(calls[0]?.variables, {
      id: "ENG-1",
      title: "Triage investigation",
    });
    assert.ok(calls[1]?.query.startsWith("mutation CreateDocument"));
    assert.deepEqual(calls[1]?.variables.input, {
      content: "# Triage investigation",
      issueId: "issue-uuid",
      title: "Triage investigation",
    });
  });

  it("refuses to write when the issue already carries two documents with the title", async () => {
    const fetchStub: typeof fetch = () =>
      json({
        data: {
          issue: {
            documents: {
              nodes: [
                { id: "a", title: "Triage investigation" },
                { id: "b", title: "Triage investigation" },
              ],
            },
            id: "issue-uuid",
          },
        },
      });
    await assert.rejects(
      saveInvestigationDocument(
        "t",
        { content: "x", issue: "ENG-1", lane: "triage" },
        { fetch: fetchStub }
      ),
      (error: Error) => error.message.includes("already carries 2 documents")
    );
  });

  it("reports a written document with no pin when the read-back fails", async () => {
    let calls = 0;
    const fetchStub: typeof fetch = (_url, init) => {
      calls += 1;
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      if (query.startsWith("query IssueDocuments")) {
        return json({ data: { issue: { documents: { nodes: [] }, id: "i" } } });
      }
      if (query.startsWith("mutation CreateDocument")) {
        return json({ data: { documentCreate: { document, success: true } } });
      }
      return json({ message: "down" }, 503);
    };
    const result = await saveInvestigationDocument(
      "t",
      { content: "x", issue: "ENG-1", lane: "triage" },
      { fetch: fetchStub }
    );
    assert.equal(calls, 3);
    assert.equal(result.created, true);
    assert.equal(result.documentId, "doc1");
    assert.equal(result.updatedAt, undefined);
    assert.match(result.error ?? "", WAS_WRITTEN);
  });

  it("rewrites the existing document instead of creating a second", async () => {
    const { calls, fetchStub } = respond("Billing investigation");
    const result = await saveInvestigationDocument(
      "t",
      { content: "# Billing investigation", issue: "ENG-1", lane: "billing" },
      { fetch: fetchStub }
    );
    assert.equal(result.created, false);
    assert.equal(result.documentId, "doc1");
    assert.ok(calls[1]?.query.startsWith("mutation UpdateDocument"));
    assert.equal(calls[1]?.variables.id, "doc1");
  });
});
