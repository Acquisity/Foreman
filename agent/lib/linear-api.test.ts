import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ENGINEERING_TEAM_ID,
  findRelatedIssues,
  linearGraphql,
} from "./linear-api.js";

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
