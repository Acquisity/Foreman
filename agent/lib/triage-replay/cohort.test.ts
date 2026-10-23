import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import decideTriage from "../../tools/decide_triage.js";
import { readCohortFiles } from "./cohort-files.js";
import { triageCaseSchema, triageLabelSchema } from "./schema.js";
import { cohortSha256, splitSchema } from "./score.js";
import { FROZEN_LISTS, frozenListsSchema, seedReplayState } from "./store.js";
import { replayCatalog } from "./views.js";

const COHORT = new URL("../../../evals/triage/", import.meta.url);
const ACCOUNT_IDS = [
  /\b(?:AC|SK|PN|CA|MG|RE|SM|MM|CF|PA|IS)[0-9a-f]{32}\b/u,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/u,
  /\beyJ[A-Za-z0-9_-]{10,}\./u,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u,
];
const LONG_HEX = /\b[0-9a-f]{32,}\b/gu;
const NAME_TOKEN = /[a-z0-9&]+/gu;
const MAX_NAME_TOKENS = 6;
const read = (path: string) => readFileSync(new URL(path, COHORT), "utf8");
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

const collectStrings = (value: unknown, into: Set<string>): void => {
  if (typeof value === "string") {
    into.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, into);
    }
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectStrings(item, into);
    }
  }
};

/**
 * Hashes every 1 to 6 token window of every string and returns the ones that are in the
 * deny list. A string that repeats across files is checked once and reported under the first
 * file. It returns hash prefixes, never the text, so a failure cannot print a customer name
 * into a CI log.
 */
const denyListHits = (
  files: { name: string; text: string }[],
  denied: ReadonlySet<string>
) => {
  const seen = new Set<string>();
  return files.flatMap(({ name, text }) => {
    const strings = new Set<string>();
    collectStrings(JSON.parse(text), strings);
    const hits = new Set<string>();
    for (const value of strings) {
      if (seen.has(value)) {
        continue;
      }
      seen.add(value);
      const tokens = value.toLowerCase().match(NAME_TOKEN) ?? [];
      for (let size = 1; size <= MAX_NAME_TOKENS; size += 1) {
        for (let start = 0; start + size <= tokens.length; start += 1) {
          const hash = sha256(tokens.slice(start, start + size).join(" "));
          if (denied.has(hash)) {
            hits.add(hash.slice(0, 12));
          }
        }
      }
    }
    return [...hits].map((hash) => `${name}: ${hash}`);
  });
};

const caseFiles = readdirSync(new URL("cases/", COHORT))
  .filter((name) => name.endsWith(".json"))
  .map((name) => ({
    content: readFileSync(new URL(`cases/${name}`, COHORT)),
    name,
  }));
const cases = caseFiles.map((file) =>
  triageCaseSchema.parse(JSON.parse(String(file.content)))
);
const split = splitSchema.parse(JSON.parse(read("split.json")));
const train = triageLabelSchema
  .array()
  .parse(JSON.parse(read("labels/train.json")));

describe("frozen triage cohort", () => {
  it("matches its frozen hash, so a changed case or frozen list is a new cohort", () => {
    const frozen = JSON.parse(read("cohort.json")) as {
      count: number;
      sha256: string;
    };
    assert.equal(frozen.count, 150);
    assert.equal(
      cohortSha256(readCohortFiles(fileURLToPath(COHORT))),
      frozen.sha256
    );
  });

  it("hashes every frozen list, so editing one without a new hash fails", () => {
    const files = readCohortFiles(fileURLToPath(COHORT));
    const frozen = JSON.parse(read("cohort.json")) as { sha256: string };
    assert.deepEqual(
      files
        .map((file) => file.name)
        .filter((name) => name.startsWith("frozen/"))
        .sort(),
      FROZEN_LISTS.map((name) => `frozen/${name}.json`)
    );
    for (const target of files.filter((file) =>
      file.name.startsWith("frozen/")
    )) {
      const edited = files.map((file) =>
        file === target
          ? { ...file, content: `${String(file.content)} ` }
          : file
      );
      assert.notEqual(cohortSha256(edited), frozen.sha256, target.name);
    }
  });

  it("holds the documented mix", () => {
    const strata = Object.fromEntries(
      [...new Set(cases.map((c) => c.stratum))].map((s) => [
        s,
        cases.filter((c) => c.stratum === s).length,
      ])
    );
    assert.deepEqual(strata, {
      billing: 25,
      bug_master: 37,
      duplicate: 23,
      duplicate_hard_negative: 10,
      platform_limitation: 25,
      unproven: 15,
      user_error: 15,
    });
    assert.ok(cases.filter((c) => c.flags.alreadyFixedAtTriage).length >= 5);
    const confirmedClosures = train.filter(
      (label) =>
        !label.insufficient &&
        (label.classification === "User Error" ||
          label.classification === "Platform Limitation") &&
        label.labelSource.some(
          (s) => s === "human_state" || s === "human_comment"
        )
    );
    assert.ok(confirmedClosures.length >= 5);
  });

  it("keeps a person's explanation of a confirmed non-bug closure as its cause", () => {
    const explained = train.filter(
      (label) => label.rootCause && label.rootCause.files.length === 0
    );
    assert.ok(explained.length >= 5);
    for (const label of explained) {
      assert.ok(label.labelSource.includes("human_comment"), label.id);
      assert.equal(label.fixPr, null, label.id);
    }
    const cancelled = train.find((label) => label.id === "ENG-14286");
    assert.deepEqual(cancelled?.rootCause, {
      files: [],
      functions: [],
      text: "Staff confirmed they had cancelled the domain.",
    });
  });

  it("splits every case once, and no incident group spans train and held-out", () => {
    const ids = cases.map((c) => c.id).sort();
    assert.deepEqual([...split.train, ...split.heldout].sort(), ids);
    const groups = split.groups as Record<string, string>;
    const heldout = new Set(split.heldout.map((id) => groups[id]));
    const crossing = split.train.filter((id) => heldout.has(groups[id]));
    assert.deepEqual(crossing, []);
  });

  it("labels every train case, and only train cases", () => {
    assert.deepEqual(train.map((l) => l.id).sort(), [...split.train].sort());
  });

  it("holds no account ids, keys, emails or long hex ids other than commit SHAs", () => {
    const leaks = [
      ...caseFiles.map((f) => ({ name: f.name, text: String(f.content) })),
      { name: "labels/train.json", text: read("labels/train.json") },
    ].flatMap(({ name, text }) => [
      ...ACCOUNT_IDS.filter((pattern) => pattern.test(text)).map(
        (pattern) => `${name}: ${pattern.source.slice(0, 20)}`
      ),
      ...(text.match(LONG_HEX) ?? [])
        .filter((hex) => hex.length !== 40)
        .map(() => `${name}: long hex id`),
    ]);
    assert.deepEqual(leaks, []);
  });

  it("holds no customer name from the deny list in any case, train label or frozen file", () => {
    const frozenNames = readdirSync(new URL("frozen/", COHORT)).filter((name) =>
      name.endsWith(".json")
    );
    const denied = new Set(
      (JSON.parse(read("denylist.sha256.json")) as { sha256: string[] }).sha256
    );
    const hits = denyListHits(
      [
        ...caseFiles.map((f) => ({
          name: `cases/${f.name}`,
          text: String(f.content),
        })),
        { name: "labels/train.json", text: read("labels/train.json") },
        ...frozenNames.map((name) => ({
          name: `frozen/${name}`,
          text: read(`frozen/${name}`),
        })),
      ],
      denied
    );
    assert.deepEqual(hits, []);
  });

  it("finds a deny-listed phrase inside any string, and reports only a hash prefix", () => {
    const denied = new Set([sha256("zzprobe name")]);
    const text = JSON.stringify({ notes: ["Seen: ZZProbe Name, again"] });
    const hits = denyListHits([{ name: "probe.json", text }], denied);
    assert.deepEqual(hits, [
      `probe.json: ${sha256("zzprobe name").slice(0, 12)}`,
    ]);
    assert.deepEqual(
      denyListHits([{ name: "clean.json", text: '["zzprobe"]' }], denied),
      []
    );
  });

  it("never shows a held-out ticket's outcome in a train case's snapshot", () => {
    const heldout = new Set(split.heldout);
    const trainIds = new Set(split.train);
    const exposed = cases
      .filter((c) => trainIds.has(c.id))
      .flatMap((c) =>
        c.relatedSnapshot
          .filter(
            (r) =>
              heldout.has(r.id) &&
              [r.assignee, r.labels, r.parent, r.state].some(
                (field) => field !== "unknown"
              )
          )
          .map((r) => `${c.id}:${r.id}`)
      );
    assert.deepEqual(exposed, []);
  });

  it("dates every frozen list entry, so the replay can answer as of each case", () => {
    const lists = frozenListsSchema.parse(
      Object.fromEntries(
        FROZEN_LISTS.map((name) => [
          name,
          JSON.parse(read(`frozen/${name}.json`)),
        ])
      )
    );
    const undated = FROZEN_LISTS.flatMap((name) =>
      lists[name]
        .filter((entry) => entry.createdAt === undefined)
        .map((entry) => `${name}:${entry.name}`)
    );
    assert.deepEqual(undated, []);
  });

  it("gives every case a Stage 5 catalog that decide_triage accepts", () => {
    const lists = frozenListsSchema.parse(
      Object.fromEntries(
        FROZEN_LISTS.map((name) => [
          name,
          JSON.parse(read(`frozen/${name}.json`)),
        ])
      )
    );
    const { projects, rootCauseLabels } = (
      decideTriage.inputSchema as z.ZodObject<{
        projects: z.ZodType;
        rootCauseLabels: z.ZodType;
      }>
    ).shape;
    const refused = cases.filter((c) => {
      const catalog = replayCatalog(seedReplayState(c, lists, ""));
      return !(
        projects.safeParse(catalog.projects).success &&
        rootCauseLabels.safeParse(catalog.rootCauseLabels).success
      );
    });
    assert.deepEqual(
      refused.map((c) => c.id),
      []
    );
  });

  it("seeds each case's filed assignee, project and priority from the frozen lists", () => {
    const lists = frozenListsSchema.parse(
      Object.fromEntries(
        FROZEN_LISTS.map((name) => [
          name,
          JSON.parse(read(`frozen/${name}.json`)),
        ])
      )
    );
    const staff = new Set(lists.users.map((user) => user.name));
    const projects = new Set(lists.projects.map((project) => project.name));
    const labels = new Set(lists.labels.map((label) => label.name));
    const refused = cases.flatMap((c) => {
      const filed = c.asFiled;
      if (filed === undefined) {
        return [`${c.id}: no asFiled`];
      }
      const { issue } = seedReplayState(c, lists, "");
      return [
        ...(filed.assignee === null || staff.has(filed.assignee)
          ? []
          : [`${c.id}: assignee`]),
        ...(filed.project === null || projects.has(filed.project)
          ? []
          : [`${c.id}: project`]),
        ...(filed.labels.every((name) => labels.has(name))
          ? []
          : [`${c.id}: labels`]),
        ...(issue.assignee === filed.assignee &&
        issue.project === filed.project &&
        issue.priority === filed.priority &&
        issue.parent === filed.parent
          ? []
          : [`${c.id}: not seeded`]),
      ];
    });
    assert.deepEqual(refused, []);
    assert.ok(cases.some((c) => c.asFiled?.assignee));
  });

  it("keeps every snapshot issue older than its case", () => {
    const later = cases.flatMap((c) =>
      c.relatedSnapshot
        .filter((r) => r.createdAt >= c.createdAt)
        .map((r) => `${c.id}:${r.id}`)
    );
    assert.deepEqual(later, []);
  });
});
