import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionAuthContext } from "eve/context";
import type { z } from "zod";
import type { FindRelatedIssuesResult } from "#lib/linear-api.js";
import definition, { searchKnownIssues } from "../tools/widget_known_issues.js";

// Mirrors the shape searchKnownIssues() derives from findRelatedIssues().
// biome-ignore lint/suspicious/useAwait: test mock mirrors the async helper signature.
const mockFindRelatedIssues = async (
  phrases: string[]
): Promise<FindRelatedIssuesResult> => {
  const [query] = phrases;
  if (query === "error test") {
    throw new Error("Linear GraphQL request failed: HTTP 500.");
  }
  if (query === "empty") {
    return { createdAfter: null, issues: [], truncated: false };
  }
  return {
    createdAfter: null,
    issues: [
      {
        assignee: "Jamie Lee",
        createdAt: "2026-09-01T00:00:00.000Z",
        identifier: "ENG-1200",
        labels: ["bug"],
        matchedPhrases: [query],
        parentIdentifier: null,
        state: "Done",
        stateType: "completed",
        title: "Growth plan creator stuck on processing for some orgs",
        url: "https://linear.app/acquisity/issue/ENG-1200",
      },
      {
        assignee: null,
        createdAt: "2026-09-10T00:00:00.000Z",
        identifier: "ENG-1305",
        labels: ["bug", "customer-reported"],
        matchedPhrases: [query],
        parentIdentifier: null,
        state: "In Progress",
        stateType: "started",
        title: "Growth plan creator stuck for orgs with long descriptions",
        url: "https://linear.app/acquisity/issue/ENG-1305",
      },
    ],
    truncated: false,
  };
};

const opts = {
  client: {} as never,
  signal: new AbortController().signal,
};
const searchKnownIssuesForTest = (query: string) =>
  searchKnownIssues(query, opts, (input) =>
    mockFindRelatedIssues(input.phrases)
  );

const widgetCtx = {
  session: {
    auth: {
      initiator: {
        attributes: {},
        issuer: "foreman:widget-support",
      } as SessionAuthContext,
    },
  },
};

describe("widget_known_issues tool", () => {
  it("is exposed only for widget support auth", () => {
    const dynamic = definition;
    const nonWidgetCtx = {
      session: { auth: { initiator: null } },
    };

    const toolForWidget = dynamic.events["step.started"]?.(
      {},
      widgetCtx as any
    );
    assert.ok(toolForWidget, "tool should be exposed for widget auth");

    const toolForNonWidget = dynamic.events["step.started"]?.(
      {},
      nonWidgetCtx as any
    );
    assert.equal(
      toolForNonWidget,
      null,
      "tool should be hidden for non-widget auth"
    );
  });

  it("returns only identifier, title, and status — no PII fields", async () => {
    const result = await searchKnownIssuesForTest("growth plan stuck");
    assert.equal(result.issues.length, 2, "should return both matches");
    for (const issue of result.issues) {
      assert.deepEqual(
        Object.keys(issue).sort(),
        ["identifier", "status", "title"],
        "issue should carry exactly identifier, status, title"
      );
    }
    assert.equal(result.issues[0].identifier, "ENG-1305");
    assert.equal(result.issues[0].status, "In Progress");
  });

  it("prefers open issues over closed ones", async () => {
    const result = await searchKnownIssuesForTest("growth plan stuck");
    assert.equal(
      result.issues[0].identifier,
      "ENG-1305",
      "the started issue should sort ahead of the completed one"
    );
    assert.equal(result.issues[1].identifier, "ENG-1200");
  });

  it("handles empty results", async () => {
    const result = await searchKnownIssuesForTest("empty");
    assert.deepEqual(result.issues, []);
    assert.equal(result.error, undefined);
  });

  it("reports an error without throwing when the search fails", async () => {
    const result = await searchKnownIssuesForTest("error test");
    assert.equal(result.issues.length, 0);
    assert.equal(result.error, "Known-issue search could not run.");
  });

  it("input schema bounds query length and trims", () => {
    const tool = definition.events["step.started"]?.({}, widgetCtx as never) as
      | { inputSchema: z.ZodType }
      | null
      | undefined;
    assert.ok(tool);
    const parse = (query: string) => tool.inputSchema.safeParse({ query });
    assert.equal(parse("ab").success, false);
    assert.equal(parse("abc").success, true);
    assert.equal(parse("a".repeat(120)).success, true);
    assert.equal(parse("a".repeat(121)).success, false);
    assert.deepEqual(parse("  query  ").data, { query: "query" });
  });
});
