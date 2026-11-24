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
