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
