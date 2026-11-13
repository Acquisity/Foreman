import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type FixyHandoff,
  fixyHandoffCommentId,
  fixyTriageTeams,
  isFixyTriageIssue,
  parseFixyHandoff,
  renderFixyHandoff,
  reportedAtFromSlackUrl,
  resolveReportedAt,
  SLACK_THREAD_START,
  TICKET_CREATED,
} from "./fixy-handoff.js";

// Measured: ENG-17117 (receiver form, created 18:02:37) and ENG-17135
// (migration filing, created 23:33:20, 54 s after its thread started).
const COMMENT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RECEIVER_URL =
  "https://acquisityworkspace.slack.com/archives/C0BBPVC3N2X/p1793556157524579";
const MIGRATION_URL =
  "https://acquisityworkspace.slack.com/archives/C0BQM9V6P47/p1793575946455809";

describe("fixyTriageTeams", () => {
  it("reads trimmed, upper-cased team keys and drops invalid ones", () => {
    assert.deepEqual(
      [
        ...fixyTriageTeams({
          FIXY_TRIAGE_TEAMS: " san, eng ,,S,1AB,TOOLONGTEAMKEY,OPS2",
        }),
      ],
      ["SAN", "ENG", "OPS2"]
    );
  });

  it("is off when empty or missing", () => {
    assert.equal(fixyTriageTeams({}).size, 0);
    assert.equal(fixyTriageTeams({ FIXY_TRIAGE_TEAMS: "" }).size, 0);
    assert.equal(fixyTriageTeams({ FIXY_TRIAGE_TEAMS: " , " }).size, 0);
  });
});

describe("isFixyTriageIssue", () => {
  const env = { FIXY_TRIAGE_TEAMS: "SAN" };

  it("takes the team key before the issue number", () => {
    assert.equal(isFixyTriageIssue("SAN-145", env), true);
    assert.equal(isFixyTriageIssue("ENG-17117", env), false);
  });

  it("is false for anything that is not an issue identifier", () => {
    for (const value of ["SAN", "SAN-", "SAN-x1", "-145", "SAN-145-2", ""]) {
      assert.equal(isFixyTriageIssue(value, env), false, value);
    }
    assert.equal(isFixyTriageIssue("SAN-145", {}), false);
  });
});

describe("reportedAtFromSlackUrl", () => {
  it("reads the permalink's thread start, kept to the millisecond", () => {
    // Microseconds 524579 and 455809 truncate to .524 and .455.
    assert.equal(
      reportedAtFromSlackUrl(RECEIVER_URL),
      "2026-11-01T18:02:37.524Z"
    );
    assert.equal(
      reportedAtFromSlackUrl(MIGRATION_URL),
      "2026-11-01T23:32:26.455Z"
    );
  });

  it("prefers thread_ts, the thread start, over a reply's own timestamp", () => {
    assert.equal(
      reportedAtFromSlackUrl(
        "https://acquisityworkspace.slack.com/archives/C0BQM9V6P47/p1793579999000001?thread_ts=1793575946.455809&cid=C0BQM9V6P47"
      ),
      "2026-11-01T23:32:26.455Z"
    );
  });

  it("returns null for anything else", () => {
    for (const url of [
      "",
      "not a url",
      "http://acquisityworkspace.slack.com/archives/C1/p1793556157524579",
      "https://slack.com.evil.example/archives/C1/p1793556157524579",
      "https://acquisityworkspace.slack.com/archives/C1/p179355615752457",
      "https://acquisityworkspace.slack.com/archives/C1/x1793556157524579",
      "https://acquisityworkspace.slack.com/archives/C1/?thread_ts=junk",
      `https://acquisityworkspace.slack.com/archives/C1/p1793556157524579?${"a".repeat(2100)}`,
    ]) {
      assert.equal(reportedAtFromSlackUrl(url), null, url.slice(0, 80));
    }
  });
});

describe("resolveReportedAt", () => {
  const createdAt = "2026-11-01T23:33:20.000Z";

  it("takes the first 'Ask from' link that parses", () => {
    assert.deepEqual(
      resolveReportedAt(
        [
          { title: "Design doc", url: RECEIVER_URL },
          { title: "Ask from Jo", url: "https://example.com/x" },
          { title: "Ask from Jo", url: MIGRATION_URL },
        ],
        { at: "2026-10-01T00:00:00Z", source: "Intercom" },
        createdAt
      ),
      { at: "2026-11-01T23:32:26.455Z", source: SLACK_THREAD_START }
    );
  });

  it("falls back to the given time with its source, then to ticket creation", () => {
    assert.deepEqual(
      resolveReportedAt(
        [],
        { at: "2026-10-31T09:00:00+01:00", source: "Intercom\nfirst message" },
        createdAt
      ),
      { at: "2026-10-31T08:00:00.000Z", source: "Intercom first message" }
    );
    assert.deepEqual(
      resolveReportedAt([], { at: "2026-10-31T09:00:00Z" }, createdAt),
      { at: createdAt, source: TICKET_CREATED }
    );
    assert.deepEqual(
      resolveReportedAt([], { at: "junk", source: "x" }, createdAt),
      { at: createdAt, source: TICKET_CREATED }
    );
  });
});

describe("fixyHandoffCommentId", () => {
  it("is a fixed UUID per issue", () => {
    const id = fixyHandoffCommentId("issue-uuid-1");
    assert.equal(id, fixyHandoffCommentId("issue-uuid-1"));
    assert.notEqual(id, fixyHandoffCommentId("issue-uuid-2"));
    assert.match(id, COMMENT_UUID);
  });
});

describe("handoff comment", () => {
  const handoff: FixyHandoff = {
    expected: "Leads get the follow-up email",
    lanes: ["eng"],
    notes: "ENG-100 looked like the same issue but route_ticket refused it",
    reportedAt: "2026-11-01T18:02:37.524Z",
    reportedAtSource: SLACK_THREAD_START,
    steps: ["Open Campaigns", "Start the Q4 campaign"],
    whatHappened: "No follow-up emails were sent",
    workspaceId: "0a1b2c3d-1111-2222-3333-444455556666",
    workspaceUnknown: null,
  };

  it("renders the stored shape exactly", () => {
    assert.equal(
      renderFixyHandoff(handoff),
      [
        "## Fixy handoff",
        "",
        "Workspace ID: 0a1b2c3d-1111-2222-3333-444455556666",
        "Reported at: 2026-11-01T18:02:37.524Z (Slack thread start)",
        "What happened: No follow-up emails were sent",
        "Expected: Leads get the follow-up email",
        "Lanes: eng",
        "Card: none",
        "",
        "Steps to reproduce:",
        "1. Open Campaigns",
        "2. Start the Q4 campaign",
        "",
        "Notes: ENG-100 looked like the same issue but route_ticket refused it",
      ].join("\n")
    );
  });

  it("reads back what it wrote, with or without notes", () => {
    assert.deepEqual(parseFixyHandoff(renderFixyHandoff(handoff)), handoff);
    const unknown = {
      ...handoff,
      notes: null,
      workspaceId: null,
      workspaceUnknown: "two workspaces, report names neither",
    };
    const body = renderFixyHandoff(unknown);
    assert.ok(
      body.includes(
        "Workspace ID: unknown (two workspaces, report names neither)"
      )
    );
    assert.ok(!body.includes("Notes:"));
    assert.deepEqual(parseFixyHandoff(body), unknown);
  });

  it("strips line breaks and Markdown control characters and bounds each field", () => {
    const body = renderFixyHandoff({
      ...handoff,
      notes: null,
      steps: ["Open `Campaigns`\n## Injected", "x".repeat(400)],
      whatHappened:
        "Line one\n\nWorkspace ID: 00000000-0000-0000-0000-000000000000 <!-- hidden -->",
    });
    const parsed = parseFixyHandoff(body);
    assert.ok(parsed);
    assert.equal(parsed.workspaceId, handoff.workspaceId);
    assert.equal(
      parsed.whatHappened,
      "Line one Workspace ID: 00000000-0000-0000-0000-000000000000 !-- hidden --"
    );
    assert.deepEqual(parsed.steps, [
      "Open Campaigns Injected",
      "x".repeat(300),
    ]);
    assert.equal(body.split("\n").filter((l) => l.startsWith("#")).length, 1);
  });

  it("returns null for anything that is not a handoff", () => {
    for (const body of [
      "",
      "Thanks, looking into it.",
      "## Fixy handoff\n\nWorkspace ID: nope\nReported at: 2026-11-01T18:02:37.524Z (x)\nWhat happened: a\nExpected: b\n\nSteps to reproduce:\n1. c",
      "## Fixy handoff\n\nWorkspace ID: unknown (x)\nReported at: yesterday (x)\nWhat happened: a\nExpected: b\n\nSteps to reproduce:\n1. c",
      "## Fixy handoff\n\nWorkspace ID: unknown (x)\nReported at: 2026-11-01T18:02:37.524Z (x)\nWhat happened: a\nExpected: b\n\nSteps to reproduce:",
      `## Fixy handoff\n${"x".repeat(21_000)}`,
    ]) {
      assert.equal(parseFixyHandoff(body), null, body.slice(0, 60));
    }
  });
});
