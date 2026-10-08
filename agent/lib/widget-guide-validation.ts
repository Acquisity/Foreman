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
