import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { makeCase, makeLabel } from "./fixtures.js";
import {
  findLeaks,
  type LeakageHit,
  leaksThatCount,
  shingles,
} from "./leakage.js";
import type { TriageResult } from "./schema.js";

const FIX_COMMIT = "3f9c2b7d41e85a0c6b19d2e4f7a3c8b5d0e1f2a3";
const label = makeLabel("ENG-1", { fixCommit: FIX_COMMIT, fixPr: 6108 });
const pr = {
  body: "Keeps the cached layout in memory until the panel finishes its second render pass, and adds a regression test for saving twice.",
  title: "Keep cached layout through panel re-render",
};
const { ticket } = makeCase("ENG-1");
const baseline = `${ticket.title}\n${ticket.description}`;
const CLEAN =
  "Ticket ENG-1: the widget shows a blank panel after saving. Related: ENG-40 slow exports, state Done. Commit 0123456789 on main.";

const seeded = (
  content: string,
  source = "linear.issue",
  availableAt: string | null = null
) => ({
  availableAt,
  content,
  provenance: "seeded" as const,
  source,
});
const run = (...inputs: TriageResult["inputs"]) => ({ inputs });
const scan = (...inputs: TriageResult["inputs"]) =>
  findLeaks({ baseline, label, pr, result: run(...inputs) });

test("the fix commit planted in seeded evidence fails, as a full SHA or a 7+ character prefix", () => {
  for (const planted of [
    FIX_COMMIT,
    FIX_COMMIT.slice(0, 7),
    FIX_COMMIT.slice(0, 12).toUpperCase(),
  ]) {
    const hits = scan(
      seeded(CLEAN),
      seeded(`see ${planted} for context`, "related.ENG-40")
    );
    assert.deepEqual(
      hits.map(({ kind, source }) => [kind, source]),
      [["fix_commit", "related.ENG-40"]]
    );
  }
  assert.deepEqual(scan(seeded(`short ${FIX_COMMIT.slice(0, 6)} only`)), []);
});

test("the fix PR's number, title or body planted in seeded evidence fails", () => {
  for (const planted of [
    "fixed in #6108.",
    "https://github.com/Acquisity/Acquisity/pull/6108",
  ]) {
    assert.deepEqual(
      scan(seeded(planted)).map(({ kind }) => kind),
      ["fix_pr"]
    );
  }
  assert.deepEqual(scan(seeded("see #61080 and step #610")), []);
  assert.deepEqual(
    scan(
      seeded("Comment: keep cached layout through panel re-render, please")
    ).map(({ kind }) => kind),
    ["pr_title"]
  );
  assert.deepEqual(
    scan(
      seeded(
        "Note: it keeps the cached layout in memory until the panel finishes its second render pass."
      )
    ).map(({ kind }) => kind),
    ["pr_body"]
  );
});

test("code a fix PR quotes is not a leak when the run reads that code at the pinned commit", () => {
  const code = [
    "const layout = cache.get(panelId);",
    "cache.clear(panelId); // reset before the second render pass of the panel",
    "return renderPanel(layout, options);",
  ].join("\n");
  const quoting = {
    body: `Moves the clear call.\n\n\`\`\`ts\n${code}\n\`\`\`\n\n- cache.clear(panelId); // reset before the second render pass of the panel\nUses \`cache.clear(panelId); // reset before the second render pass of the panel\` later.`,
    title: "Move `cache.clear(panelId)` after the second panel render",
  };
  const hits = findLeaks({
    baseline,
    label,
    pr: quoting,
    result: run(seeded(code, "repo.read src/panel.ts")),
  });
  assert.deepEqual(hits, []);
});

test("a root-cause phrase planted in seeded evidence fails", () => {
  const hits = scan(
    seeded(CLEAN),
    seeded(
      "Older note: the save handler cleared the cached layout early.",
      "related.ENG-41"
    )
  );
  assert.deepEqual(hits, [
    {
      availableAt: null,
      kind: "root_cause",
      match: "the save handler cleared the",
      source: "related.ENG-41",
    },
  ]);
});

test("clean seeded evidence passes", () => {
  assert.deepEqual(
    scan(seeded(CLEAN), seeded("Projects: Platform, Billing, Growth")),
    []
  );
});

test("the same root-cause phrase only in a generated input passes", () => {
  const document = {
    availableAt: null,
    content: `Root cause: ${label.rootCause?.text} Fixed by ${FIX_COMMIT} in #6108. ${pr.title}.`,
    provenance: "generated" as const,
    source: "linear.document",
  };
  assert.deepEqual(scan(seeded(CLEAN), document), []);
});

test("words the ticket itself used are not leaks, even when the PR or root cause quotes them", () => {
  const quoting = makeLabel("ENG-1", {
    rootCause: {
      files: [],
      functions: [],
      text: "The widget shows a blank panel after saving because the layout cache is cleared.",
    },
  });
  const hits = findLeaks({
    baseline,
    label: quoting,
    pr: { body: "", title: "Blank panel after save" },
    result: run(seeded(`${ticket.title}. ${ticket.description}`)),
  });
  assert.deepEqual(hits, []);
});

test("shingles are lowercased, stripped of punctuation and skip stopword-only runs", () => {
  assert.deepEqual(
    [...shingles("It is what it is, the Cache!")],
    ["what it is the cache"]
  );
});

describe("already fixed at triage", () => {
  const CREATED = "2026-09-01T10:00:00.000Z";
  const fixed = {
    createdAt: CREATED,
    flags: { alreadyFixedAtTriage: true },
  };
  const hitIn = (
    kind: LeakageHit["kind"],
    availableAt: string | null
  ): LeakageHit => ({ availableAt, kind, match: "x", source: "grep" });

  it("exempts only fix references found in evidence that existed at triage", () => {
    const inCode = hitIn("fix_commit", CREATED);
    const prRef = hitIn("fix_pr", "2026-08-30T00:00:00.000Z");
    assert.deepEqual(leaksThatCount([inCode, prRef], fixed), {
      availableAtTriage: [inCode, prRef],
      counted: [],
    });
    assert.deepEqual(
      leaksThatCount([inCode], {
        ...fixed,
        flags: { alreadyFixedAtTriage: false },
      }),
      { availableAtTriage: [], counted: [inCode] }
    );
  });

  it("still counts a later PR-body conclusion, a root-cause phrase, or an untimed input", () => {
    const later = hitIn("pr_body", CREATED);
    const cause = hitIn("root_cause", CREATED);
    const untimed = hitIn("fix_pr", null);
    const afterCase = hitIn("fix_commit", "2026-09-02T00:00:00.000Z");
    assert.deepEqual(
      leaksThatCount([later, cause, untimed, afterCase], fixed),
      {
        availableAtTriage: [],
        counted: [later, cause, untimed, afterCase],
      }
    );
  });

  it("exempts nothing when the fix PR merged after the case was filed", () => {
    const inCode = hitIn("fix_commit", CREATED);
    assert.deepEqual(
      leaksThatCount([inCode], fixed, { mergedAt: "2026-09-05T00:00:00Z" }),
      { availableAtTriage: [], counted: [inCode] }
    );
  });

  it("carries each input's evidence time onto its hits", () => {
    const hits = scan(seeded(`see ${FIX_COMMIT}`, "grep", CREATED));
    assert.deepEqual(
      hits.map((hit) => hit.availableAt),
      [CREATED]
    );
  });
});
