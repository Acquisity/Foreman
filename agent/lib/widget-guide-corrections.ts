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
  /**
   * A summary line citing the article may not match these. A summary line
   * stands alone, so it must carry a rule the section can split over lines.
   */
  rejectSummary?: RegExp[];
  /** The article's section, and only the section, must match each of these. */
  require?: RegExp[];
  slugs: string[];
}

const CREDITS_NOTE =
  'Only plan credits and one-time packs never expire. No credit resets on the billing date. Say the never-expire rule in its own sentence, apart from monthly packs. Monthly-pack credits carry over only while the pack is active, so also say: "If the pack ends, its credits end with it."';

const NEVER =
  "(?:never|don['’]?t|doesn['’]?t|do not|does not|won['’]?t|will not|aren['’]?t meant to)";

/**
 * A credit never expiring or resetting. Not resetting when the plan renews or
 * on the billing date is true of every credit, so that claim is left alone.
 */
const RENEWAL = String.raw`\b(?:renews|renewal|billing date)\b`;
const NEVER_ENDS = String.raw`(?:\b${NEVER} (?:reset (?:or|and) )?expire|(?<!${RENEWAL}[^.;\n]*)\b${NEVER} reset(?![^.;\n]*${RENEWAL}))`;

const ONLY_PLAN_AND_ONE_TIME = String.raw`\b(?:plan(?:-included)? credits|plan and one-time|one-time|one-off|top-?ups?)\b`;

/** Each claim is judged by its own clause, never by another on the line. */
const CREDITS_CHECKS = {
  reject: [
    new RegExp(
      String.raw`(?<!^#[^\n]*)(?<!${ONLY_PLAN_AND_ONE_TIME}[^.;,\n]*)${NEVER_ENDS}`,
      "imu"
    ),
    new RegExp(String.raw`\bmonthly\b[^.;\n]*${NEVER_ENDS}`, "iu"),
  ],
  require: [
    new RegExp(
      String.raw`(?<!\b${NEVER} (?:\w+ )?)\bend with (?:it|the pack)\b`,
      "iu"
    ),
  ],
};

/**
 * A claim is judged within its clause, which starts a line or follows "." or
 * ";": `CLAUSE + IN_CLAUSE(a) + IN_CLAUSE(b)` needs a and b in one clause.
 */
const CLAUSE = "(?:^|[.;])";
const IN_CLAUSE = (pattern: string) => String.raw`(?=[^.;\n]*${pattern})`;

const BILLING_PLANS = String.raw`\bBilling"?\s*(?:>|→)\s*"?View plans`;
const OTHER_ROLES = String.raw`\b(?:admins?|members?|clients?|everyone|anyone|all (?:roles|users))\b`;
const CANT = String.raw`\b(?:can[’']?t|cannot|can not|unable|not able|don[’']?t|do not)\b`;

/** The agent pausing a campaign, not a campaign that is already paused. */
const PAUSES = String.raw`\b(?:pauses|pausing)\b`;
const ANY_SPACE = String.raw`(?:\b(?:however much|no matter how much|any amount of)\b|\bplenty of (?:free )?(?:lead )?(?:space|room|slots)\b|\beven (?:when|if|with)\b[^.;\n]*\b(?:space|room|slots?)\b|\b(?:whatever|regardless of) (?:\S+ ){0,3}?(?:\S+-)?(?:space|room|storage|slots?|check)\b)`;
const LOW_SPACE = String.raw`(?:\b2,?000\b|\b2k\b|\bfree (?:lead )?(?:slots|space)\b|\b(?:running out of|short (?:of|on)|low on) (?:lead )?(?:space|slots|room)\b|\b(?:space|room|storage) is (?:tight|short|low|full|running out)\b|\bworkspace is (?:nearly |almost )?full\b)`;

export const GUIDE_CORRECTIONS: readonly GuideCorrection[] = [
  {
    note: `${CREDITS_NOTE} Domains are $18/year only when pre-warmed, so keep "Pre-warmed" on that price.`,
    reject: [
      ...CREDITS_CHECKS.reject,
      /(?<!pre-warmed )\bdomains? (?:cost |are )?\$18/iu,
    ],
    require: CREDITS_CHECKS.require,
    slugs: ["workspace-settings/billing"],
  },
  {
    note: CREDITS_NOTE,
    ...CREDITS_CHECKS,
    slugs: [
      "cold-email-agent/concepts/credits",
      "workspace-settings/faq/billing-subscriptions/when-do-my-credits-reset",
    ],
  },
  {
    note: 'No one can split an invoice, the Owner included. Only the Owner sees "Invoices" and "Payment method".',
    reject: [/(?<!\b(?:no one|nobody|not)\s)\bcan split\b/iu],
    slugs: [
      "workspace-settings/faq/billing-subscriptions/can-i-split-an-invoice-into-two",
    ],
  },
  {
    note: "This article is about meeting platforms only. Write no line about skipped leads from it.",
    reject: [/\bskipped\b/iu],
    slugs: ["sales-call-analyzer/faq/can-i-use-google-meet-or-teams"],
  },
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
      /^(?=.*(?:blocked|do.not.contact))(?=.*(?:force-add|Delete selected)).*$/imu,
      /^(?!#)(?!.*duplicate)(?=.*(?:force-add|Delete selected[^\n]*re-?import)).*$/imu,
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
    note: '"US numbers only" is said of the phone line search, not of iMessage lines. Do not contact status and the do-not-contact list block calls and texts; only a STOP reply leaves calls unaffected. Caller ID is the assigned number or a verified personal phone, and an owner or admin verifies it on "My phone"; say both options. Keep the workspace recording default ("Record outgoing calls by default" on the "Calling" tab, owners and admins) and that "Dialling speed" is for owners and admins (ENG-21319).',
    reject: [
      /iMessage lines?"?[\s.(:]*(?:are\s+)?US[- ](?:numbers\s+)?only/iu,
      /US[- ]only iMessage/iu,
      /\bUS (?:numbers?|only)[^.;\n]{0,30}\bfor iMessage/iu,
      /(?<!calls and )texts? (?:are )?blocked by (?:Do not contact|do-not-contact)/iu,
      /(?:Do not contact|do-not-contact)(?:(?!STOP)[^.;\n])*\bblocks? (?:only texts|texts only)/iu,
    ],
    require: [
      /\bassigned number\b/iu,
      /"My phone"/u,
      /"Record outgoing calls by default"/u,
      /\bowners?\b[^\n]*"Dialling speed"|"Dialling speed"[^\n]*\b(?:owners?|admins?)\b/iu,
    ],
    slugs: ["crm/calling-and-texting"],
  },
  {
    note: 'The support chat ("Feedback") is not on the sign-in page, so a customer who can\'t log in asks someone on their team to ask for them. Keep that.',
    require: [/\b(?:team|teammate)\b/iu],
    slugs: ["account-settings/faq/i-didnt-receive-the-forgot-password-email"],
  },
  {
    note: 'Clients lose only workspace settings, "Members", "Billing" and credits. They keep personal settings (Profile, Appearance, Security, Availability, Email & Calendar, Conferencing), so say "workspace settings", never just "settings", and list personal settings whenever you list what Clients see.',
    reject: [
      /\b(?:never|no|not|can[’']?t|cannot|don[’']?t|doesn[’']?t)(?: (?:see|open|change|access|use|get|have))?(?: access to)?(?: (?:any|the))? "?settings\b/iu,
      /^(?!#)(?![^{\n]*\bpersonal)[^{\n]*(?:\b(?:sees?|gets?) only\b|\bonly (?:sees?|gets?)\b)[^.;{\n]*"[^.;{\n]*,.*$/imu,
    ],
    slugs: ["client-portal"],
  },
  {
    note: 'Anyone can top up AI Website Builder credits from the prompt. Only the "Settings" > "Billing" > "Buy credits" route is for workspace owners, so any line saying only owners buy credits names that route in the same sentence.',
    reject: [
      /(?:^|[.;])(?![^.;\n]*(?:\b(?:in|via|through|from|under|on) (?:the )?"?(?:Settings|Billing)\b|(?<!\()"Settings" >|(?<![("])\bSettings >))[^.;\n]*\bonly (?:workspace )?owners?\b[^.;\n]*\b(?:buy|top[- ]?up|purchase)/imu,
      /(?:^|[.;])(?![^.;\n]*\bBilling\b)[^.;\n]*\bowners?[- ]only\b/imu,
    ],
    slugs: ["ai-website-builder/credits-and-limits"],
  },
  {
    note: "Only a DFY inbox still warming up can't be added to a live campaign. Say warming up in the same sentence as any line saying a DFY inbox can't join a live campaign.",
    reject: [
      /(?:^|[.;])(?![^.;{\n]*\bwarm)[^.;{\n]*(?:\b(?:DFY|done-for-you)\b[^.;{\n]*\b(?:can[’']?t|cannot|not|don[’']?t|doesn[’']?t)\b|\b(?:can[’']?t|cannot|don[’']?t|do not)\s+(?:add|use)\s+(?:any |a )?(?:DFY|done-for-you)\b)[^.;{\n]*\b(?:(?:live|running|active|launched) campaign|campaign (?:that[’']?s|that is) (?:already )?live)/imu,
    ],
    slugs: [
      "cold-email-agent/faq/email-accounts",
      "cold-email-agent/email-accounts/dfy-warmup-and-reconnect-errors",
    ],
  },
  {
    note: 'A domain can be assigned to one website at a time. You change or disconnect a domain yourself under "Manage domain" ("Change website", "Disconnect"). This article says nothing about support, counties or lead location.',
    reject: [
      /\bone domain (?:per|for each|a) website\b/iu,
      /\b(?:each|a|one|per) website\b[^.;\n]{0,30}(?<!(?<!\bno )more than )\bone domain\b/iu,
      /\b(?:no|can[’']?t|cannot|not)\b[^.;\n]*\bwithout (?:contacting |asking )?support\b/iu,
      /(?<!\b(?:no|not|don[’']?t|never)\b[^.;\n]{0,15})\b(?:ask|contact|needs?|requires?)\b[^.;\n]{0,10}\bsupport\b/iu,
      /\bcount(?:y|ies)\b/iu,
      /\blead location\b/iu,
    ],
    slugs: ["ai-website-builder/domains"],
  },
  {
    note: 'While storage is full, existing campaigns can still send, and hitting the limit deletes nothing on its own; say both. "Settings" > "Billing" > "View plans" is for workspace owners only: give it to owners alone, in its own sentence. Then say, a sentence each: owners and admins can use "View plans" in the campaign-lead warning; members use "Compare plans" there; Client users can\'t change the plan.',
    reject: [
      new RegExp(
        String.raw`${CLAUSE}(?:(?![^.;\n]*\bowners?\b)|${IN_CLAUSE(OTHER_ROLES)})[^.;\n]*${BILLING_PLANS}`,
        "imu"
      ),
      new RegExp(
        CLAUSE +
          IN_CLAUSE(String.raw`\bmembers?\b`) +
          `(?![^.;\\n]*(?:Compare plans|${CANT}))` +
          IN_CLAUSE("View plans"),
        "imu"
      ),
      new RegExp(
        String.raw`${CLAUSE}(?:(?!\b(?:doesn[’']?t|does not|don[’']?t|do not|won[’']?t|will not|never|not|no)\b)[^.;\n])*?\bstop(?:s|ped)? sending\b|\b(?:can[’']?t|cannot|can not|won[’']?t|will not|no longer|unable to|blocked from) (?:\w+ )?send(?:s|ing)?\b|\bstill not send(?:s|ing)?\b|\b(?:aren[’']?t|are not|isn[’']?t|is not) sending\b`,
        "imu"
      ),
    ],
    require: [
      new RegExp(
        CLAUSE +
          IN_CLAUSE(String.raw`\bowners?\b`) +
          `(?![^.;\\n]*${OTHER_ROLES})` +
          IN_CLAUSE(BILLING_PLANS),
        "imu"
      ),
      /^(?!#)[^\n]*(?:\bstill\b[^.\n]*\bsend|\bsend(?:ing)?\b[^.\n]*\bstill\b|\bkeeps? sending\b|\bcontinues? (?:to send|sending)\b)/imu,
      /\b(?:nothing|no leads?)\b[^.;\n]*\b(?:auto(?:matically)?[- ]?deleted|deleted automatically)|\b(?:doesn[’']?t|does not|never|won[’']?t|will not)\b[^.;\n]*\bauto(?:matically)?[- ]?delete|\bdeletes? (?:nothing|no leads)\b/iu,
      new RegExp(
        CLAUSE +
          IN_CLAUSE(String.raw`\badmins?\b`) +
          IN_CLAUSE("View plans") +
          IN_CLAUSE(String.raw`\b(?:warning|prompt)\b`),
        "imu"
      ),
      new RegExp(
        CLAUSE +
          IN_CLAUSE(String.raw`\bmembers?\b`) +
          IN_CLAUSE("Compare plans"),
        "imu"
      ),
      new RegExp(
        CLAUSE + IN_CLAUSE(String.raw`\bClients?\b`) + IN_CLAUSE(CANT),
        "imu"
      ),
    ],
    slugs: [
      "cold-email-agent/faq/lead-search/why-does-the-lead-limit-prompt-block-sending-when-i-have-leads-and-credits",
    ],
  },
  {
    note: "\"Clear out old leads\" removes leads in two cases. Clearing space: when a check finds fewer than 2,000 free lead slots, it removes people who got every email or whose email bounced, from paused or completed campaigns at least 90 days old that haven't changed for 30 days. Pausing a campaign: when the agent pauses a campaign, it can remove that campaign's bounced leads, however much space you have. A summary line about when it removes leads names both cases.",
    rejectSummary: [
      new RegExp(
        String.raw`^(?=[^{\n]*\b(?:clear(?:s|ing)? out|remov|delet))(?![^\n]*${ANY_SPACE})[^\n]*${LOW_SPACE}`,
        "iu"
      ),
    ],
    require: [
      new RegExp(
        CLAUSE +
          IN_CLAUSE(PAUSES) +
          IN_CLAUSE(
            String.raw`(?<!\b(?:never|not|doesn[’']?t|won[’']?t|can[’']?t|cannot)\s)\b(?:remov|delet|clear)`
          ) +
          IN_CLAUSE(String.raw`\bbounc`) +
          `(?:${IN_CLAUSE(ANY_SPACE)}|(?![^.;\\n]*${LOW_SPACE}))`,
        "imu"
      ),
    ],
    slugs: [
      "cold-email-agent/faq/campaigns/does-acquisity-delete-my-leads-automatically",
    ],
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
  if (!(c?.note || c?.reject || c?.rejectSummary || c?.require)) {
    return [];
  }
  return [
    JSON.stringify({
      note: c.note ?? "",
      reject: (c.reject ?? []).map(String),
      require: (c.require ?? []).map(String),
      ...(c.rejectSummary && {
        rejectSummary: c.rejectSummary.map(String),
      }),
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
  [...line.matchAll(GUIDE_CITATION)].some((m) => {
    const c = bySlug.get(m[1].trim());
    return [...(c?.reject ?? []), ...(c?.rejectSummary ?? [])].some((pattern) =>
      pattern.test(line)
    );
  });

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
