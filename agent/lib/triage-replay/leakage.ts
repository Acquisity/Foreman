import type { TriageLabel, TriageResult } from "./schema.js";

/**
 * The scorer's leakage check (ENG-16049): did a replay see the answer? Only
 * inputs seeded from the case or frozen lists are scanned. Content the run
 * wrote itself and read back (`generated`) is skipped, so Foreman's own
 * correct document is never counted as a leak.
 */

/** What a leakage hit found: the fix commit, PR number, PR title or body, or a root-cause phrase. */
export const LEAK_KINDS = [
  "fix_commit",
  "fix_pr",
  "pr_title",
  "pr_body",
  "root_cause",
] as const;
export type LeakKind = (typeof LEAK_KINDS)[number];

export interface LeakageHit {
  availableAt: string | null;
  kind: LeakKind;
  /** The matched text: a SHA prefix, a PR reference or one shingle. */
  match: string;
  /** The `source` of the seeded input it was found in. */
  source: string;
}

export interface LeakageInput {
  /**
   * The ticket title and description as first created. Its words are the
   * case's own question, so a shingle it already contains is not a leak:
   * a fix PR or root cause that quotes the report would otherwise fail
   * every clean case.
   */
  baseline?: string;
  label: TriageLabel;
  /** The fix PR's title and body, fetched by the CLI; omit when the label has no fix PR. */
  pr?: { body: string; mergedAt?: string | null; title: string };
  result: Pick<TriageResult, "inputs">;
}

/** Root-cause and PR-title shingle length. */
export const SHINGLE_WORDS = 5;
/** PR bodies carry template text, so they need a longer run of words to count. */
export const BODY_SHINGLE_WORDS = 8;

const STOPWORDS = new Set(
  "a about after all also an and any are as at be because been before but by can could did do does for from had has have he her his how i if in into is it its just may more most no not of on only or other our out over she so some such than that the their them then there these they this those to up us was we were what when where which who will with would you your".split(
    " "
  )
);

const NON_WORD = /[^\p{L}\p{N}]+/gu;
const FENCED = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE = /`[^`\n]*`/g;
const DIFF_LINE = /^\s*(?:[+-]|@@).*$/gm;
const HEX_TOKEN = /\b[0-9a-f]{7,40}\b/gi;
const MIN_SHA_PREFIX = 7;
/** A whole PR title counts only from this many words; shorter titles match common phrases. */
const MIN_TITLE_WORDS = 4;

/** Lowercased words with punctuation stripped. */
export const words = (text: string) =>
  text.toLowerCase().replace(NON_WORD, " ").trim().split(" ").filter(Boolean);

/** Every run of `size` words, skipping runs made only of stopwords. */
export function shingles(text: string, size = SHINGLE_WORDS): Set<string> {
  const tokens = words(text);
  const out = new Set<string>();
  for (let start = 0; start + size <= tokens.length; start += 1) {
    const run = tokens.slice(start, start + size);
    if (run.some((word) => !STOPWORDS.has(word))) {
      out.add(run.join(" "));
    }
  }
  return out;
}

/**
 * PR text without fenced blocks, inline code or diff lines. A replay reads
 * the code at the pinned commit legitimately, so code quoted in a fix PR
 * would otherwise mark every run that found the buggy lines as leaked.
 */
export const prose = (text: string) =>
  text.replace(FENCED, " ").replace(INLINE_CODE, " ").replace(DIFF_LINE, " ");

const prPattern = (pr: number) =>
  new RegExp(`(?:(?<![\\w#])#${pr}|/pull/${pr})(?!\\d)`, "i");

function shingleHits(
  needles: Set<string>,
  content: string,
  size: number,
  baseline: Set<string>
) {
  const haystack = shingles(content, size);
  return [...needles].filter(
    (shingle) => haystack.has(shingle) && !baseline.has(shingle)
  );
}

type Detector = (content: string) => string | undefined;

/** One detector per leak kind the label and PR allow; a kind with nothing to look for is absent. */
function detectors(
  label: TriageLabel,
  pr: LeakageInput["pr"],
  baseline: string
): [LeakKind, Detector][] {
  const known = shingles(baseline);
  const out: [LeakKind, Detector][] = [];
  const commit = label.fixCommit?.toLowerCase();
  if (commit) {
    out.push([
      "fix_commit",
      (content) =>
        content
          .match(HEX_TOKEN)
          ?.find(
            (token) =>
              token.length >= MIN_SHA_PREFIX &&
              commit.startsWith(token.toLowerCase())
          ),
    ]);
  }
  if (label.fixPr) {
    const ref = prPattern(label.fixPr);
    out.push(["fix_pr", (content) => content.match(ref)?.[0]]);
  }
  if (pr) {
    const title = shingles(prose(pr.title));
    const tokens = words(prose(pr.title));
    const whole =
      tokens.length >= MIN_TITLE_WORDS &&
      !` ${words(baseline).join(" ")} `.includes(` ${tokens.join(" ")} `)
        ? ` ${tokens.join(" ")} `
        : null;
    out.push([
      "pr_title",
      (content) =>
        whole && ` ${words(content).join(" ")} `.includes(whole)
          ? whole.trim()
          : shingleHits(title, content, SHINGLE_WORDS, known)[0],
    ]);
    const body = shingles(prose(pr.body), BODY_SHINGLE_WORDS);
    const knownBody = shingles(baseline, BODY_SHINGLE_WORDS);
    out.push([
      "pr_body",
      (content) => shingleHits(body, content, BODY_SHINGLE_WORDS, knownBody)[0],
    ]);
  }
  if (label.rootCause) {
    const rootCause = shingles(label.rootCause.text);
    out.push([
      "root_cause",
      (content) => shingleHits(rootCause, content, SHINGLE_WORDS, known)[0],
    ]);
  }
  return out;
}

/**
 * Scan every seeded input for the fix commit (full SHA or any 7+ character
 * prefix), the fix PR as `#<n>` or `/pull/<n>`, the PR title and body, and
 * 5-word shingles of the label's root cause. Returns one hit per kind and
 * input; an empty list means the run is clean.
 */
export function findLeaks({
  baseline = "",
  label,
  pr,
  result,
}: LeakageInput): LeakageHit[] {
  const checks = detectors(label, pr, baseline);
  return result.inputs
    .filter(({ provenance }) => provenance === "seeded")
    .flatMap(({ availableAt, content, source }) =>
      checks.flatMap(([kind, detect]) => {
        const match = detect(content);
        return match
          ? [{ availableAt: availableAt ?? null, kind, match, source }]
          : [];
      })
    );
}

const AVAILABLE_KINDS: ReadonlySet<LeakKind> = new Set([
  "fix_commit",
  "fix_pr",
  "pr_title",
]);

/**
 * A case whose fix merged before triage ran could legitimately find that fix
 * then, but only in evidence that existed at triage (the pinned code or the
 * as-of snapshot, timed at or before the case's creation), and only as a
 * reference to the fix: its commit, PR number or title. A root-cause phrase
 * or PR-body text always counts, and nothing is exempt when the PR merged
 * after the case was filed.
 */
export function leaksThatCount(
  hits: LeakageHit[],
  triageCase:
    | { createdAt: string; flags: { alreadyFixedAtTriage: boolean } }
    | undefined,
  pr?: { mergedAt?: string | null }
): { counted: LeakageHit[]; availableAtTriage: LeakageHit[] } {
  const fixedBefore =
    triageCase?.flags.alreadyFixedAtTriage === true &&
    !(pr?.mergedAt && pr.mergedAt >= triageCase.createdAt);
  const available = (hit: LeakageHit) =>
    fixedBefore &&
    triageCase !== undefined &&
    AVAILABLE_KINDS.has(hit.kind) &&
    hit.availableAt !== null &&
    hit.availableAt <= triageCase.createdAt;
  return {
    availableAtTriage: hits.filter(available),
    counted: hits.filter((hit) => !available(hit)),
  };
}
