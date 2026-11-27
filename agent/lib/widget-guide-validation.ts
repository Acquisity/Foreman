const LONE_DASH =
  /(?<=[(["'\u201c\u2018])\u2014|\u2014(?=[)\]"'\u201d\u2019])/gu;
const DASH = /[ \t]*\u2014[ \t]*/gu;
const SECTION = /^### .+ \{slug: ([^}\n]+)\}$/u;
const HEADINGS = /^### .*$/gmu;

/** A generated guide must keep exactly one section for every source article. */
export function assertGuideSections(
  text: string,
  slugs: readonly string[]
): void {
  const expected = new Set(slugs);
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const [heading] of text.matchAll(HEADINGS)) {
    const slug = SECTION.exec(heading)?.[1];
    if (!slug) {
      problems.push(`invalid heading: ${heading}`);
    } else if (!expected.has(slug)) {
      problems.push(`unexpected slug: ${slug}`);
    } else if (seen.has(slug)) {
      problems.push(`duplicate slug: ${slug}`);
    } else {
      seen.add(slug);
    }
  }
  const missing = slugs.filter((slug) => !seen.has(slug));
  if (missing.length) {
    problems.push(`missing slugs: ${missing.join(", ")}`);
  }
  if (problems.length) {
    throw new Error(`Invalid product guide: ${problems.join("; ")}`);
  }
}

/** A fact line that answers with another article's slug instead of the answer. */
const POINTER_ANSWER =
  /^\s*(?:[-*] )?Same as:? (?:slug )?\{?(?:slug: )?[a-z0-9][a-z0-9/-]*\}?[.,;]?\s*$/u;

/**
 * Every section carries its own answer (ENG-20311): a "Same as <slug>" line in
 * place of the facts drops the answer from the guide.
 */
export function assertOwnAnswers(text: string): void {
  const pointers: string[] = [];
  let slug = "";
  for (const line of text.split("\n")) {
    slug = SECTION.exec(line)?.[1] ?? slug;
    if (POINTER_ANSWER.test(line)) {
      pointers.push(slug);
    }
  }
  if (pointers.length) {
    throw new Error(
      `sections answer with another article: ${[...new Set(pointers)].join(", ")}`
    );
  }
}

const WORD = /\S+/gu;
/** An article this long in the docs needs more than a one-liner (ENG-20575). */
export const LONG_ARTICLE_CHARS = 1500;
export const MIN_ANSWER_WORDS = 12;
/** A how-to with this many numbered steps needs room for them (ENG-20601). */
export const MANY_STEPS = 4;
export const MIN_STEPS_ANSWER_WORDS = 20;
const STEP = /^\s*\d+\. /gmu;

/** How many numbered steps a docs article has. */
export const numberedSteps = (text: string) => text.match(STEP)?.length ?? 0;

/** Each section's fact words, not counting its heading and "Get here:" line. */
export const answerWords = (text: string): Map<string, number> =>
  new Map(
    [...factLines(text)].map(([slug, facts]) => [
      slug,
      facts.match(WORD)?.length ?? 0,
    ])
  );

/**
 * The slugs whose section answers a long article in fewer than
 * MIN_ANSWER_WORDS words, or an article with MANY_STEPS numbered steps in
 * fewer than MIN_STEPS_ANSWER_WORDS.
 */
export function shortAnswers(
  text: string,
  articles: readonly { slug: string; text: string }[]
): string[] {
  const words = answerWords(text);
  return articles
    .filter((a) => {
      const said = words.get(a.slug) ?? 0;
      return (
        (a.text.length >= LONG_ARTICLE_CHARS && said < MIN_ANSWER_WORDS) ||
        (numberedSteps(a.text) >= MANY_STEPS && said < MIN_STEPS_ANSWER_WORDS)
      );
    })
    .map((a) => a.slug);
}

/** A regenerated section keeping less than this share of main's words has shrunk. */
export const SHRUNK_SHARE = 0.8;
/** A quoted label, without punctuation written inside its closing quote. */
const QUOTED = /"([^"\n]*?[^"\n.,;:!?])[.,;:!?]*"/gu;
const quotedLabels = (text: string) =>
  new Set([...text.matchAll(QUOTED)].map((m) => m[1]));

/** Each section's fact lines, without its heading and "Get here:" line. */
function factLines(text: string): Map<string, string> {
  const facts = new Map<string, string[]>();
  let slug = "";
  for (const line of text.split("\n")) {
    const heading = SECTION.exec(line)?.[1];
    if (heading) {
      slug = heading;
      facts.set(slug, []);
    } else if (slug && !line.startsWith("Get here:")) {
      facts.get(slug)?.push(line);
    }
  }
  return new Map([...facts].map(([key, lines]) => [key, lines.join("\n")]));
}

export interface AnswerLoss {
  /** Labels main's section quotes that the article still has and this one lacks. */
  dropped: string[];
  now: number;
  slug: string;
  was: number;
}

/**
 * Each section of `text` measured against the same article's section in
 * `previous`, the guide on main: its fact words, main's, and the UI labels it
 * dropped. A model that keeps to a long article's word allowance can drop half
 * its facts (ENG-21319); a label counts as dropped only while the article in
 * `sources` still names it. Articles main doesn't have are left out.
 */
export function answerLosses(
  text: string,
  previous: string,
  sources: ReadonlyMap<string, string>
): AnswerLoss[] {
  const before = factLines(previous);
  return [...factLines(text)].flatMap(([slug, facts]) => {
    const main = before.get(slug);
    if (main === undefined) {
      return [];
    }
    const source = sources.get(slug) ?? "";
    const kept = quotedLabels(facts);
    const dropped = [...quotedLabels(main)].filter(
      (label) => source.includes(label) && !kept.has(label)
    );
    return [
      {
        dropped,
        now: facts.match(WORD)?.length ?? 0,
        slug,
        was: main.match(WORD)?.length ?? 0,
      },
    ];
  });
}

/** A section that dropped one of main's labels or most of main's words. */
export const lostGround = (loss: AnswerLoss): boolean =>
  loss.dropped.length > 0 || loss.now < loss.was * SHRUNK_SHARE;

/**
 * A retry's section replaces the earlier one when it drops no label the
 * earlier one kept, and drops fewer of main's labels or as many in more words.
 */
export const retryKeeps = (
  before: Pick<AnswerLoss, "dropped" | "now">,
  after: Pick<AnswerLoss, "dropped" | "now">
): boolean =>
  after.dropped.every((label) => before.dropped.includes(label)) &&
  (after.dropped.length < before.dropped.length || after.now > before.now);

const BLOCK_SCALAR = /^[>|][+-]?$/u;
const INDENTED = /^[ \t]/u;

/** One front matter value, including a folded or literal block scalar (`title: >-`). */
export function frontmatterField(front: string, name: string): string {
  const lines = front.split("\n");
  const at = lines.findIndex((line) => line.startsWith(`${name}:`));
  if (at < 0) {
    return "";
  }
  const head = lines[at].slice(name.length + 1).trim();
  let value = head;
  if (BLOCK_SCALAR.test(head)) {
    const block: string[] = [];
    for (const line of lines.slice(at + 1)) {
      // The block runs until the next top-level key; blank lines stay inside it.
      if (line.trim() && !INDENTED.test(line)) {
        break;
      }
      block.push(line.trim());
    }
    value = block.filter(Boolean).join(" ");
  }
  return value.replace(/^["']|["']$/gu, "").trim();
}

/**
 * Agent-facing text carries no em dashes. One standing alone as a symbol, as
 * in "(—)", becomes "-"; one between words becomes a comma.
 */
export const plainDashes = (text: string): string =>
  text.replace(LONE_DASH, "-").replace(DASH, ", ");
