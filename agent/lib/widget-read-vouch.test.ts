import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import { type GateDeps, gate } from "./widget-egress.js";
import type { WidgetFindings } from "./widget-findings.js";
import { workspaceReadText } from "./widget-read-vouch.js";

const YOUTUBE = /youtube\.com/u;
const SECRET = /secret\.example/u;

const read = (toolName: string, output: unknown, isError = false) => ({
  callId: "c",
  isError,
  kind: "tool-result",
  output,
  toolName,
});
// The workspace's own Knowledge Base, as the AI generation read returns it (ENG-20659).
const knowledgeBase = read("widget_ai_generation", {
  sections: {
    knowledgeBase: {
      entries: [
        {
          text: "Listen to the podcast on youtube.com/@ourshow and on spotify.com.",
        },
      ],
    },
  },
  status: "ok",
});
const deps: GateDeps = {
  compose: () =>
    Promise.resolve("Your knowledge base points listeners to youtube.com."),
  judge: () => Promise.resolve({ decision: "allow", reason: "in scope" }),
  resolve: () =>
    Promise.resolve({
      domains: new Set<string>(),
      emails: new Set<string>(),
      slugs: new Set<string>(),
      uuids: new Set<string>(),
    }),
};
const findings = (claim: string): WidgetFindings => ({
  confidence: "high",
  facts: [
    {
      claim,
      entityIds: [],
      evidence: { ref: "knowledgeBase", tool: "widget_ai_generation" },
    },
  ],
  needsHuman: false,
  recommendation: "Keep the podcast links in your knowledge base up to date.",
  report: "The knowledge base names the podcast's sites.",
});
const question =
  "What does my knowledge base tell the AI about where people can listen to the podcast?";
const answer = (claim: string, reads: unknown[]) =>
  gate(
    scope,
    question,
    findings(claim),
    deps,
    question,
    false,
    undefined,
    false,
    undefined,
    question,
    new Date(),
    reads.map(workspaceReadText).join("\n")
  );

test("a domain the workspace's own read returned may be named (ENG-20659)", async () => {
  const result = await answer(
    "Your knowledge base tells the AI the podcast is on youtube.com and spotify.com.",
    [knowledgeBase]
  );
  assert.equal(result.decision, "allow");
  assert.match(result.message ?? "", YOUTUBE);
});

test("another workspace's domain, a known issue's domain or a diagnosis-only value still never reaches the reply", async () => {
  const claim = "Your podcast is also listed on rival-agency.com.";
  for (const reads of [
    [knowledgeBase],
    [
      knowledgeBase,
      read("widget_known_issues", {
        issues: [{ text: "Seen on rival-agency.com" }],
      }),
    ],
    [
      read("widget_inboxes", {
        error: { diagnosisOnly: true, value: "rival-agency.com refused" },
      }),
    ],
    [read("widget_inboxes", { site: "rival-agency.com" }, true)],
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: each read set is one case.
    const result = await answer(claim, reads);
    // The item naming it is dropped and never reaches the customer.
    assert.equal(
      JSON.stringify([result.findings, result.message]).includes(
        "rival-agency.com"
      ),
      false,
      JSON.stringify(reads)
    );
  }
});

test("only a successful read of the workspace vouches, and never its diagnosis-only values", () => {
  assert.match(workspaceReadText(knowledgeBase), YOUTUBE);
  for (const notRead of [
    read("widget_known_issues", { text: "x.com" }),
    read("widget_help_article", { url: "x.com" }),
    read("widget_file_ticket", { url: "x.com" }),
    read("report_capability_gap", { gap: "x.com" }),
    read("widget_inboxes", { site: "x.com" }, true),
    {
      kind: "tool-error",
      output: { site: "x.com" },
      toolName: "widget_inboxes",
    },
  ]) {
    assert.equal(workspaceReadText(notRead), "", JSON.stringify(notRead));
  }
  assert.doesNotMatch(
    workspaceReadText(
      read("widget_inboxes", {
        error: { diagnosisOnly: true, value: "secret.example" },
        ok: "kept.com",
      })
    ),
    SECRET
  );
});

test("an email in a read never drops the domain it shares, typed or read (ENG-20659 review)", async () => {
  const kbWithEmail = read("widget_ai_generation", {
    sections: {
      knowledgeBase: {
        text: "Listen at podcast-host.com; contact producer@podcast-host.com.",
      },
    },
    status: "ok",
  });
  const claim = "Your knowledge base sends listeners to podcast-host.com.";
  for (const typed of [question, `${question} What about podcast-host.com?`]) {
    // biome-ignore lint/performance/noAwaitInLoops: each input is one case.
    const result = await gate(
      scope,
      typed,
      findings(claim),
      { ...deps, compose: () => Promise.resolve(claim) },
      typed,
      false,
      undefined,
      false,
      undefined,
      typed,
      new Date(),
      workspaceReadText(kbWithEmail)
    );
    assert.equal(result.decision, "allow", typed);
    assert.equal(result.message, claim);
  }
});
