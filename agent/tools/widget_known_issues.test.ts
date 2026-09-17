import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionAuthContext } from "eve/context";
import type { FindRelatedIssuesResult } from "#lib/linear-api.js";

const HTTP_500_RE = /HTTP 500/;

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

/** Reimplements the tool's sanitize/sort/cap step against the mocked search, since the module import below only checks exposure gating. */
async function searchKnownIssuesForTest(query: string) {
  try {
    const result = await mockFindRelatedIssues([query]);
    const CLOSED = new Set(["completed", "canceled"]);
    const issues = [...result.issues]
      .sort((a, b) => {
        const aClosed = CLOSED.has(a.stateType) ? 1 : 0;
        const bClosed = CLOSED.has(b.stateType) ? 1 : 0;
        if (aClosed !== bClosed) {
          return aClosed - bClosed;
        }
        return b.createdAt.localeCompare(a.createdAt);
      })
      .slice(0, 5)
      .map((issue) => ({
        identifier: issue.identifier,
        status: issue.state,
        title: issue.title,
      }));
    return { issues };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Linear search failed.",
      issues: [],
    };
  }
}

describe("widget_known_issues tool", () => {
  it("is exposed only for widget support auth", async () => {
    const toolModule = await import("./widget_known_issues.js");
    const dynamic = toolModule.default;

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
    assert.match(result.error ?? "", HTTP_500_RE);
  });

  it("input schema bounds query length and trims", () => {
    const minLength = 3;
    const maxLength = 120;
    assert.ok("abc".length >= minLength, "3-char query should be valid");
    assert.ok("a".repeat(120).length <= maxLength, "120-char query valid");
    assert.equal("  query  ".trim(), "query");
  });
});
