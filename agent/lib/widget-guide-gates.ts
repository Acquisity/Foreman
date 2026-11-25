// Help Centre feature gates the widget guide must keep (ENG-20607): a page or
// section behind an opt-in feature is off until it is turned on for the
// workspace, so the guide says so instead of dropping the condition.

/** Said of a page or section behind an opt-in feature. */
export const OPT_IN_NOTE = "Only on workspaces where it has been turned on.";
const OPT_OUT_NOTE = "Only on workspaces where it has not been turned on.";

const FEATURE_GATE =
  /<FeatureGate\s+feature="([^"]+)"(\s+not)?\s*>([\s\S]*?)<\/FeatureGate>/gu;
const PAGE_FEATURES = /^features:\s*\[([^\]]*)\]/mu;
const FEATURE_KEY = /[a-z0-9_]+/gu;

/**
 * MDX with each opt-in `<FeatureGate>` section spelled out: its text is opened
 * with OPT_IN_NOTE and closed with an end marker, so the condition stays with
 * exactly that text. A `not` gate shows its text only where the feature is
 * off, and says so. Any other gate is left for the MDX strip.
 */
export const spellOutOptInGates = (
  mdx: string,
  optIn: ReadonlySet<string>
): string =>
  mdx.replace(
    FEATURE_GATE,
    (gate, key: string, not: string | undefined, inner: string) => {
      if (!optIn.has(key)) {
        return gate;
      }
      const note = not ? OPT_OUT_NOTE : OPT_IN_NOTE;
      return `\nNote: ${note}\n${inner.trim()}\n(End of the part that is ${note.charAt(0).toLowerCase()}${note.slice(1, -1)}.)\n`;
    }
  );

/** Whether a page's front matter (`features: [...]`) puts it behind an opt-in feature. */
export const pageIsOptIn = (
  frontMatter: string,
  optIn: ReadonlySet<string>
): boolean =>
  (frontMatter.match(PAGE_FEATURES)?.[1].match(FEATURE_KEY) ?? []).some((key) =>
    optIn.has(key)
  );
