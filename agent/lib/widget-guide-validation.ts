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

const BLOCK_SCALAR = /^[>|][+-]?$/u;

/** One front matter value, including a folded or literal block scalar (`title: >-`). */
export function frontmatterField(front: string, name: string): string {
  const match = front.match(
    new RegExp(`^${name}:[ \\t]*(.*)$((?:\\n[ \\t]+.*)*)`, "mu")
  );
  if (!match) {
    return "";
  }
  const [, head = "", rest = ""] = match;
  const value = BLOCK_SCALAR.test(head.trim())
    ? rest
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" ")
    : head;
  return value.replace(/^["']|["']$/gu, "").trim();
}
