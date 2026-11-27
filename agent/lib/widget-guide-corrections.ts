/**
 * Lines a guide regeneration got wrong that the Help Centre gets right
 * (ENG-21059). Each output is cached under a hash of its inputs, so a wrong
 * line stays until something changes them: a correction's note goes into its
 * article's inputs, which redoes that article and its summary lines only, and
 * tells the model what a past run misread. Its checks then refuse the wrong
 * line if it comes back: a section that fails is distilled again, and a
 * summary line that fails is dropped, since its article section keeps the
 * fact. Add one when a guide review finds a line the article contradicts and
 * the article is already clear.
 */
export interface GuideCorrection {
  /** What a past run got wrong, in the article's own terms. */
  note: string;
  /** Neither the article's section nor its summary lines may match these. */
  reject?: RegExp[];
  /** The article's section must match each of these. */
  require?: RegExp[];
  slug: string;
}

const CLIENT_PORTAL_PATH = /^Get here:.*"Client Portal"/mu;
const HAS_GET_HERE = /^Get here:/mu;
const BILLED_WITH_PLAN = /billed with (?:your|the) plan|plan-billed/iu;
const DOMAINS_PAGE = /"Email domains and inboxes"/u;

const NOT_THE_CLIENTS_PAGE =
  'Only Client users have "Client Portal" in the sidebar. The person reading this is the owner or admin, so its "Get here:" line is "Settings" > "Members", where a client\'s role is changed.';

const CANCEL_KEEPS_BILLED_WITH_PLAN =
  'Cancelling the subscription cancels only the domains and inboxes billed with your plan. Keep the words "billed with your plan", and keep that domains billed on their own are cancelled from "Email domains and inboxes".';

export const GUIDE_CORRECTIONS: readonly GuideCorrection[] = [
  {
    note: "This article is about the AI SDR only. The Acquisity Agent is a different feature and can update a deal when asked, so write no line about the Acquisity Agent from this article.",
    reject: [/Acquisity Agent/iu],
    slug: "crm/faq/does-the-ai-sdr-update-crm-deal-stages-automatically",
  },
  {
    note: NOT_THE_CLIENTS_PAGE,
    reject: [CLIENT_PORTAL_PATH],
    require: [HAS_GET_HERE],
    slug: "client-portal/faq",
  },
  {
    note: NOT_THE_CLIENTS_PAGE,
    reject: [CLIENT_PORTAL_PATH],
    require: [HAS_GET_HERE],
    slug: "client-portal/faq/why-cant-my-client-see-a-tool",
  },
  {
    note: 'The force-add workaround ("Delete selected" in the other campaign, then re-import) is only for a lead skipped as a duplicate of another campaign. Keep it with duplicates alone, never after a list that includes blocked or do-not-contact leads.',
    reject: [/(?:blocked|do.not.contact)[^\n]*(?:force-add|Delete selected)/iu],
    slug: "cold-email-agent/campaigns/managing-campaigns/import-leads",
  },
  {
    note: CANCEL_KEEPS_BILLED_WITH_PLAN,
    require: [BILLED_WITH_PLAN, DOMAINS_PAGE],
    slug: "workspace-settings/faq/billing-subscriptions/does-pausing-a-campaign-stop-billing",
  },
  {
    note: CANCEL_KEEPS_BILLED_WITH_PLAN,
    require: [BILLED_WITH_PLAN, DOMAINS_PAGE],
    slug: "workspace-settings/faq/billing-subscriptions/what-happens-to-my-domains-if-i-cancel",
  },
  {
    note: '"US numbers only" is said of the phone line search, not of iMessage lines. Do not contact status and the do-not-contact list block calls and texts; only a STOP reply leaves calls unaffected.',
    reject: [
      /iMessage[^\n]{0,40}\bUS(?: numbers)? only\b/iu,
      /(?:Do not contact|do-not-contact)[^.\n]*calls? (?:are )?(?:unaffected|not affected)/iu,
    ],
    slug: "crm/calling-and-texting",
  },
  {
    note: 'The support chat ("Feedback") is not on the sign-in page, so a customer who can\'t log in asks someone on their team to ask for them. Keep that.',
    require: [/\b(?:team|teammate)\b/iu],
    slug: "account-settings/faq/i-didnt-receive-the-forgot-password-email",
  },
];

const bySlug = new Map(GUIDE_CORRECTIONS.map((c) => [c.slug, c]));

/** The article's correction note, or "" when it has none. */
export const correctionNote = (slug: string): string =>
  bySlug.get(slug)?.note ?? "";

/** Why an article's distilled section is refused; empty when it passes. */
export function sectionProblems(slug: string, section: string): string[] {
  const correction = bySlug.get(slug);
  if (!correction) {
    return [];
  }
  return [
    ...(correction.reject ?? [])
      .filter((pattern) => pattern.test(section))
      .map((pattern) => `${slug} matches ${pattern}`),
    ...(correction.require ?? [])
      .filter((pattern) => !pattern.test(section))
      .map((pattern) => `${slug} lacks ${pattern}`),
  ];
}

/** An article's summary lines without those its correction refuses. */
export const summaryLinesKept = (slug: string, lines: string[]): string[] => {
  const reject = bySlug.get(slug)?.reject ?? [];
  return lines.filter((line) => !reject.some((pattern) => pattern.test(line)));
};
