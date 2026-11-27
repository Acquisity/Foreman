import { GUIDE_CITATION, type GuideLimits } from "./widget-guide-cache.js";

/**
 * Lines a guide regeneration got wrong that the Help Centre gets right
 * (ENG-21059). Each output is cached under a hash of its inputs, so a wrong
 * line stays until something changes them: a correction's note and checks go
 * into its articles' inputs, which redoes those articles and their summary
 * lines only, and the note tells the model what a past run misread. The checks
 * then refuse the wrong line if it comes back: a section that fails is
 * distilled again, and a summary line that fails is dropped, since its article
 * section keeps the fact. A correction with a `path` sets the articles'
 * "Get here:" line outright, with no model call. Add one when a guide review
 * finds a line the article contradicts and the article is already clear.
 */
export interface GuideCorrection {
  /** What a past run got wrong, in the article's own terms. */
  note?: string;
  /** The "Get here:" path these articles always get. */
  path?: string;
  /** Neither the article's section nor a summary line citing it may match these. */
  reject?: RegExp[];
  /** The article's section, and only the section, must match each of these. */
  require?: RegExp[];
  slugs: string[];
}

export const GUIDE_CORRECTIONS: readonly GuideCorrection[] = [
  {
    note: "This article is about the AI SDR only. The Acquisity Agent is a different feature and can update a deal when asked, so write no line about the Acquisity Agent from this article.",
    reject: [/Acquisity Agent/iu],
    slugs: ["crm/faq/does-the-ai-sdr-update-crm-deal-stages-automatically"],
  },
  {
    path: '"Settings" > "Members"',
    slugs: [
      "client-portal/faq",
      "client-portal/faq/why-cant-my-client-see-a-tool",
    ],
  },
  {
    note: 'The force-add workaround ("Delete selected" in the other campaign, then re-import) is only for a lead skipped as a duplicate of another campaign. Say so in the same line, and never put it after a list that includes blocked or do-not-contact leads.',
    reject: [
      /(?:blocked|do.not.contact)[^\n]*(?:force-add|Delete selected)/iu,
      /^(?!#)(?!.*duplicate)(?=.*force-add).*$/imu,
    ],
    slugs: ["cold-email-agent/campaigns/managing-campaigns/import-leads"],
  },
  {
    note: 'Cancelling the subscription cancels only the domains and inboxes billed with your plan. Keep the words "billed with your plan" on the line that says what cancelling does to domains, and keep that domains billed on their own are cancelled from "Email domains and inboxes".',
    reject: [
      /^(?!#)(?=.*\bcancel)(?=.*\bdomain)(?!.*(?:billed with (?:your|the) plan|plan-billed|billed on (?:their|its) own|"Email domains and inboxes"|\b(?:one|a|single) domain\b|refund)).*$/imu,
    ],
    require: [
      /billed with (?:your|the) plan|plan-billed/iu,
      /"Email domains and inboxes"/u,
    ],
    slugs: [
      "workspace-settings/faq/billing-subscriptions/does-pausing-a-campaign-stop-billing",
      "workspace-settings/faq/billing-subscriptions/what-happens-to-my-domains-if-i-cancel",
    ],
  },
  {
    note: '"US numbers only" is said of the phone line search, not of iMessage lines. Do not contact status and the do-not-contact list block calls and texts; only a STOP reply leaves calls unaffected.',
    reject: [
      /iMessage lines?"?\s*[(:]?\s*(?:are\s+)?US[- ](?:numbers\s+)?only/iu,
      /US[- ]only iMessage/iu,
      /\bUS (?:numbers?|only)[^.;\n]{0,30}\bfor iMessage/iu,
      /(?<!calls and )texts? (?:are )?blocked by (?:Do not contact|do-not-contact)/iu,
      /(?:Do not contact|do-not-contact)[^.;\n]*\bSTOP\b[^.;\n]*\(calls? (?:are )?(?:unaffected|not affected)\)/iu,
    ],
    slugs: ["crm/calling-and-texting"],
  },
  {
    note: 'The support chat ("Feedback") is not on the sign-in page, so a customer who can\'t log in asks someone on their team to ask for them. Keep that.',
    require: [/\b(?:team|teammate)\b/iu],
    slugs: ["account-settings/faq/i-didnt-receive-the-forgot-password-email"],
  },
];

const bySlug = new Map(
  GUIDE_CORRECTIONS.flatMap((c) => c.slugs.map((slug) => [slug, c] as const))
);

/** The note the model gets with the article, as a list empty when it has none. */
export const correctionNotes = (slug: string): string[] => {
  const note = bySlug.get(slug)?.note;
  return note ? [note] : [];
};

/**
 * What goes into the article's cache keys: the note and every check, so
 * editing either redoes the article. Empty for an article with no note or
 * check, so its keys stay as they were.
 */
export const correctionKeyInputs = (slug: string): string[] => {
  const c = bySlug.get(slug);
  if (!(c?.note || c?.reject || c?.require)) {
    return [];
  }
  return [
    JSON.stringify({
      note: c.note ?? "",
      reject: (c.reject ?? []).map(String),
      require: (c.require ?? []).map(String),
    }),
  ];
};

/** The "Get here:" path a correction sets for the article, if any. */
export const correctionPath = (slug: string): string | undefined =>
  bySlug.get(slug)?.path;

/** Why an article's distilled section is refused; empty when it passes. */
export function sectionProblems(slug: string, section: string): string[] {
  const c = bySlug.get(slug);
  return [
    ...(c?.reject ?? [])
      .filter((pattern) => pattern.test(section))
      .map((pattern) => `${slug} matches ${pattern}`),
    ...(c?.require ?? [])
      .filter((pattern) => !pattern.test(section))
      .map((pattern) => `${slug} lacks ${pattern}`),
  ];
}

/** Why a batch's sections are refused; empty when every one passes. */
export const batchProblems = (
  slugs: readonly string[],
  sections: Map<string, string>
): string[] =>
  slugs.flatMap((slug) => sectionProblems(slug, sections.get(slug) ?? ""));

const lineRefused = (line: string) =>
  [...line.matchAll(GUIDE_CITATION)].some((m) =>
    (bySlug.get(m[1].trim())?.reject ?? []).some((pattern) =>
      pattern.test(line)
    )
  );

/**
 * Summary lines split into those kept and those refused: a line is refused
 * when it matches a reject of any article it cites.
 */
export function refuseSummaryLines(limits: GuideLimits): {
  kept: GuideLimits;
  refused: string[];
} {
  const refused = [...limits.who, ...limits.cannot].filter(lineRefused);
  const keep = (lines: string[]) => lines.filter((l) => !refused.includes(l));
  return {
    kept: { cannot: keep(limits.cannot), who: keep(limits.who) },
    refused,
  };
}
