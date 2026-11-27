import assert from "node:assert/strict";
import { test } from "node:test";
import { guideCallKey } from "./widget-guide-cache.js";
import {
  batchProblems,
  correctionKeyInputs,
  correctionNotes,
  correctionPath,
  GUIDE_CORRECTIONS,
  refusedSections,
  refuseSummaryLines,
  sectionProblems,
} from "./widget-guide-corrections.js";
import { PRODUCT_GUIDE_ARTICLES } from "./widget-product-guide.js";

const AI_SDR_FAQ =
  "crm/faq/does-the-ai-sdr-update-crm-deal-stages-automatically";
const CLIENT_TOOL = "client-portal/faq/why-cant-my-client-see-a-tool";
const IMPORT = "cold-email-agent/campaigns/managing-campaigns/import-leads";
const PAUSING =
  "workspace-settings/faq/billing-subscriptions/does-pausing-a-campaign-stop-billing";
const DOMAINS =
  "workspace-settings/faq/billing-subscriptions/what-happens-to-my-domains-if-i-cancel";
const CALLING = "crm/calling-and-texting";
const FORGOT = "account-settings/faq/i-didnt-receive-the-forgot-password-email";
const BILLING = "workspace-settings/billing";
const CREDITS = "cold-email-agent/concepts/credits";
const SPLIT =
  "workspace-settings/faq/billing-subscriptions/can-i-split-an-invoice-into-two";
const RESET_FAQ =
  "workspace-settings/faq/billing-subscriptions/when-do-my-credits-reset";
const MEET = "sales-call-analyzer/faq/can-i-use-google-meet-or-teams";

const section = (slug: string, ...lines: string[]) =>
  [`### Title {slug: ${slug}}`, ...lines].join("\n");

test("every correction names an article the guide has", () => {
  for (const slug of GUIDE_CORRECTIONS.flatMap((c) => c.slugs)) {
    assert.ok(slug in PRODUCT_GUIDE_ARTICLES, slug);
  }
});

// Wrong lines are Foreman#353's at d9475c02 (ENG-21059) or the same claims
// reworded in review. Right lines are written to the Help Centre at Acquisity
// a649441c6431.
test("the sections Foreman#353 got wrong are refused, reworded too", () => {
  const wrong: [string, string][] = [
    [
      IMPORT,
      section(
        IMPORT,
        "- Skipped: duplicates in any existing campaign, already emailed, blocked, do-not-contact.",
        '- To force-add, use "Delete selected" on the other campaign\'s "Leads" tab, then re-import.'
      ),
    ],
    [
      DOMAINS,
      section(
        DOMAINS,
        "- Cancel subscription stops all domain charges.",
        '- Domains billed with your plan cancel when it ends; others from "Email domains and inboxes".'
      ),
    ],
    [CALLING, section(CALLING, "- iMessage lines: US-only.")],
    [CALLING, section(CALLING, "- Do not contact blocks texts only.")],
    // Main's section at b0deaf42 gave one Caller ID option (ENG-21319).
    [
      CALLING,
      section(
        CALLING,
        '- Caller ID: own mobile verified on "My phone" tab. Owners/admins: "Record outgoing calls by default"; "Dialling speed" tab.'
      ),
    ],
    [
      CALLING,
      section(
        CALLING,
        "- Do not contact status and the do-not-contact list block texts only."
      ),
    ],
    [
      CALLING,
      section(CALLING, '- Pick "Phone line" or "iMessage line". US only.'),
    ],
    [
      IMPORT,
      section(
        IMPORT,
        '- Use "Delete selected" to force-add duplicates or blocked leads.'
      ),
    ],
    [
      IMPORT,
      section(
        IMPORT,
        "- Skipped: duplicates, already emailed, blocked, do-not-contact.",
        '- Use "Delete selected" on the other campaign\'s "Leads" tab, then re-import.'
      ),
    ],
    [CALLING, section(CALLING, "- US-only iMessage lines.")],
    [
      CALLING,
      section(CALLING, "- Only US numbers are available for iMessage lines."),
    ],
    [
      IMPORT,
      section(
        IMPORT,
        '- Skipped: duplicates in any existing campaign, already emailed, blocked, do-not-contact. To force-add, use "Delete selected" on the other campaign\'s "Leads" tab, then re-import.'
      ),
    ],
    [
      PAUSING,
      section(
        PAUSING,
        "- No. Pausing only stops emails.",
        '- Stop billing: "Cancel subscription" at the bottom of Billing. Owner only. Access lasts to period end.'
      ),
    ],
    [
      DOMAINS,
      section(
        DOMAINS,
        "- Cancelling plan: domains work until plan ends, then cancelled. Inboxes and campaigns send until then; inboxes stop that day or month-end; warm-up lost.",
        "- Cancelling one domain: usually works until paid month ends; some removed immediately. Its inboxes cancelled."
      ),
    ],
    [
      CALLING,
      section(
        CALLING,
        '- Owners/admins: "Request number" > "Phone line" or "iMessage line" (US only) > pick, assign, confirm charge.'
      ),
    ],
    [
      CALLING,
      section(
        CALLING,
        '- Texts blocked by Do not contact status, list, or STOP (calls unaffected). "They agreed to texts again" > "Allow texts".'
      ),
    ],
    [
      FORGOT,
      section(
        FORGOT,
        'Get here: sign-in page, "Forgot password".',
        "- Check spam, Promotions; retype email.",
        '- No account yet: click "Sign up" with purchase email.',
        '- Else "Feedback".'
      ),
    ],
  ];
  for (const [slug, text] of wrong) {
    assert.notDeepEqual(sectionProblems(slug, text), [], text);
  }
});

test("right wording for the same articles passes", () => {
  const right: [string, string][] = [
    [
      IMPORT,
      section(
        IMPORT,
        "- Skipped: missing name or industry, broken email, duplicates, already in a campaign or emailed, company filter, do-not-contact.",
        '- Duplicates of another campaign: to force-add one, select it on that campaign\'s "Leads" tab, "Delete selected", then re-import.'
      ),
    ],
    [
      PAUSING,
      section(
        PAUSING,
        '- To stop billing, Owner clicks "Cancel subscription" at the bottom of Billing. Access lasts to period end, then domains and inboxes billed with your plan cancel.',
        '- Plan and domains/inboxes are separate charges. Cancel sooner, or cancel domains billed on their own, via "Email domains and inboxes".'
      ),
    ],
    [
      DOMAINS,
      section(
        DOMAINS,
        "- Cancel subscription: plan-billed domains and inboxes work until the plan ends, then cancel.",
        '- Cancel one domain ("Email domains and inboxes"): most last to paid month end; some go at once.'
      ),
    ],
    [
      CALLING,
      section(
        CALLING,
        '- Owners/admins: "Request number" > "Phone line" (US numbers only) or "iMessage line".',
        "- Calls and texts are blocked for Do not contact status and the do-not-contact list. A STOP reply blocks texts only; calls are not affected.",
        '- Caller ID: the assigned number or a mobile verified on "My phone". Owners/admins: "Record outgoing calls by default" on "Calling"; "Dialling speed" tab.'
      ),
    ],
    [
      CALLING,
      section(
        CALLING,
        '- "iMessage line" or "Phone line" (US numbers only).',
        "- Choose iMessage or Phone line (US numbers only for Phone line).",
        "- Do not contact status and the do-not-contact list block calls and texts; only a STOP reply leaves calls unaffected.",
        "- Calls and texts are blocked by Do not contact status or the do-not-contact list; a STOP reply blocks texts only (calls unaffected).",
        "- Calls and texts are blocked by Do not contact status, and a STOP reply blocks texts only (calls unaffected).",
        "- Do not contact blocks calls and texts, while STOP leaves calls unaffected.",
        '- Caller ID: the assigned number or a mobile verified on "My phone". Owners/admins: "Record outgoing calls by default" on "Calling"; "Dialling speed" tab.'
      ),
    ],
    [
      FORGOT,
      section(
        FORGOT,
        '- Still stuck: use "Feedback" in the account menu. Support chat isn\'t on the sign-in page, so ask a teammate.'
      ),
    ],
  ];
  for (const [slug, text] of right) {
    assert.deepEqual(sectionProblems(slug, text), [], text);
  }
  assert.deepEqual(
    batchProblems([IMPORT], new Map([[IMPORT, right[0][1]]])),
    []
  );
  assert.notDeepEqual(batchProblems([FORGOT], new Map()), []);
});

test("the Client Portal FAQs get the owner's Members path with no model call", () => {
  assert.equal(correctionPath(CLIENT_TOOL), '"Settings" > "Members"');
  assert.equal(correctionPath("client-portal/faq"), '"Settings" > "Members"');
  assert.equal(correctionPath("client-portal"), undefined);
  assert.deepEqual(correctionKeyInputs(CLIENT_TOOL), []);
});

test("cache keys change only for corrected articles, and with any check", () => {
  assert.deepEqual(correctionKeyInputs("crm/deals"), []);
  assert.equal(
    guideCallKey("m", "p", "text", ...correctionKeyInputs("crm/deals")),
    guideCallKey("m", "p", "text")
  );
  const calling = JSON.parse(correctionKeyInputs(CALLING)[0]);
  assert.equal(calling.note, correctionNotes(CALLING)[0]);
  assert.ok(calling.reject.includes("/US[- ]only iMessage/iu"));
  const forgot = JSON.parse(correctionKeyInputs(FORGOT)[0]);
  assert.deepEqual(forgot.require, ["/\\b(?:team|teammate)\\b/iu"]);
});

test("an article with no correction is never refused", () => {
  assert.deepEqual(sectionProblems("crm/deals", '- Text "US only".'), []);
  assert.deepEqual(correctionNotes("crm/deals"), []);
});

test("wrong summary lines from Foreman#353 are dropped, the rest kept", () => {
  const lines = [
    `- Acquisity Agent has no full autopilot for deal stages; moving stages is manual. {${AI_SDR_FAQ}}`,
    `- Closed Won and Closed Lost are always moved by hand. {${AI_SDR_FAQ}}`,
    `- iMessage lines are US only. {${CALLING}}`,
    `- Texts are blocked by Do not contact status, list, or STOP (calls unaffected). {${CALLING}}`,
    `- A STOP reply blocks texts only; calls are not affected. {${CALLING}}`,
    `- iMessage lines are US only. {crm/deals}, {${CALLING}}`,
    `- Cancel subscription stops all domain charges. {${DOMAINS}}`,
    `- Pausing a campaign doesn't stop billing. {${PAUSING}}`,
  ];
  assert.deepEqual(
    refuseSummaryLines({ cannot: lines.slice(0, 4), who: lines.slice(4) }),
    {
      kept: { cannot: [lines[1]], who: [lines[4], lines[7]] },
      refused: [lines[5], lines[6], lines[0], lines[2], lines[3]],
    }
  );
  const untouched = ["- Deals can be dragged. {crm/deals}"];
  assert.deepEqual(refuseSummaryLines({ cannot: untouched, who: [] }), {
    kept: { cannot: untouched, who: [] },
    refused: [],
  });
});

// Wrong lines are Foreman#370's at 4bf4c290 (ENG-21282), or the same claim
// reworded in review. Right lines follow the Help Centre at Acquisity
// 5a844527333d: plan credits and one-time packs never expire, monthly-pack
// credits carry over only while the pack is active, and no credit resets on
// the billing date.
test("credits never expiring is said only of plan credits and one-time packs", () => {
  const exception = "- If the pack ends, its credits end with it.";
  const wrong: [string, string][] = [
    [
      BILLING,
      section(
        BILLING,
        '- Credits never expire or reset. "Buy credits" > "One time" or "Every month" > pack > "Buy for".',
        exception
      ),
    ],
    [
      CREDITS,
      section(
        CREDITS,
        "- Credits never reset. Monthly packs add on top.",
        exception
      ),
    ],
    ...[
      "- When your plan renews, credits never expire.",
      "- Credits on every plan never expire.",
      "- Monthly packs and plan credits never expire.",
      "- Plan credits and one-time packs never expire; monthly-pack credits never expire either.",
      "- Plan credits never expire, and monthly-pack credits never expire either.",
      "- Credits aren’t meant to reset.",
      "- Credits doesn't expire.",
      "- Plan credits never expire. Credits never expire or reset.",
      "- Plan credits never expire, but credits never expire or reset.",
      "- Credits never reset or expire, even after your plan renews.",
    ].map((line): [string, string] => [
      CREDITS,
      section(CREDITS, line, exception),
    ]),
    [
      BILLING,
      section(
        BILLING,
        "- Plan credits and one-time packs never expire.",
        "- Monthly-pack credits carry over after the pack ends."
      ),
    ],
    [
      BILLING,
      section(
        BILLING,
        "- Plan credits and one-time packs never expire.",
        exception,
        "- Domains $18/year, inboxes $8/month."
      ),
    ],
    [
      BILLING,
      section(
        BILLING,
        "- Plan credits and one-time packs never expire.",
        exception,
        "- Domains are $18/year."
      ),
    ],
    [
      CREDITS,
      section(
        CREDITS,
        "- Plan credits and one-time packs never expire.",
        "- If the pack ends, its credits don't end with it."
      ),
    ],
    [
      CREDITS,
      section(
        CREDITS,
        "- Plan credits and one-time packs never expire.",
        "- If the pack ends, its credits don't automatically end with it."
      ),
    ],
  ];
  for (const [slug, text] of wrong) {
    assert.notDeepEqual(sectionProblems(slug, text), [], text);
  }
  const right: [string, string][] = [
    [
      BILLING,
      section(
        BILLING,
        "- Plan badges: Active, Trial.",
        "- Plan credits and one-time packs never expire. Monthly-pack credits carry over while the pack is active. If the pack ends, its credits end with it.",
        "- Credits don't reset on your billing date.",
        "- Credits don't reset when your plan renews.",
        "- Pre-warmed domains $18/year, inboxes $8/month."
      ),
    ],
    [
      CREDITS,
      section(
        CREDITS,
        "- Plan-included and one-time credits never reset or expire.",
        "- When your plan renews, credits don't reset.",
        "- Monthly packs add on top each month while active; unused credits end with the pack."
      ),
    ],
  ];
  for (const [slug, text] of right) {
    assert.deepEqual(sectionProblems(slug, text), [], text);
  }
  const lines = [
    `- Credits never expire or reset. {${BILLING}}`,
    `- Credits never reset. {${CREDITS}}`,
    `- When your plan renews, credits never expire. {${CREDITS}}`,
    `- Credits never reset. {${RESET_FAQ}}`,
    `- Plan and one-time pack credits never reset. {${BILLING}}`,
  ];
  assert.deepEqual(refuseSummaryLines({ cannot: lines, who: [] }), {
    kept: { cannot: [lines[4]], who: [] },
    refused: lines.slice(0, 4),
  });
});

test("summary lines Foreman#370 kept from main's guide are dropped", () => {
  const lines = [
    `- Only the Owner can split or manage invoice payment actions here; Admins lack the "Invoices" and "Payment method" permissions. {${SPLIT}}`,
    `- Client users can't dismiss the "leads were skipped during upload" notification. {${MEET}}`,
    `- An invoice can't be split into two. {${SPLIT}}`,
    `- No one can split an invoice, the Owner included. {${SPLIT}}`,
    `- Client users can't dismiss the skipped leads card. {cold-email-agent/faq/lead-search/how-do-i-hide-the-leads-were-skipped-during-upload-notification}`,
  ];
  assert.deepEqual(refuseSummaryLines({ cannot: lines, who: [] }), {
    kept: { cannot: lines.slice(2), who: [] },
    refused: lines.slice(0, 2),
  });
});

const PORTAL = "client-portal";
const SITE_CREDITS = "ai-website-builder/credits-and-limits";
const INBOX_FAQ = "cold-email-agent/faq/email-accounts";
const DFY = "cold-email-agent/email-accounts/dfy-warmup-and-reconnect-errors";
const SITE_DOMAINS = "ai-website-builder/domains";

// Wrong lines are Foreman#370's at 8b46dd20 (ENG-21290). Right lines are
// written to the Help Centre at Acquisity 6085af2ac0b6, and include #370's own
// sections for these articles where they were right.
test("wrong summary lines from Foreman#370 are dropped", () => {
  const wrong = [
    `- Only Owners buy credits for AI Website Builder ("Settings" > "Billing" > "Buy credits"). {${SITE_CREDITS}}`,
    `- Clients see only "Client Portal", "Dashboard", CRM (unless off) and partner-enabled campaigns; they never see settings, "Members", "Billing" or credits. {${PORTAL}}`,
    `- DFY inboxes can't be added to a live campaign. {${INBOX_FAQ}}`,
    `- Website Builder: no domain changes to a bought domain without support; one domain per website at a time; counties unsupported for lead location. {${SITE_DOMAINS}}`,
    `- Clients can't open settings. {${PORTAL}}`,
    `- Done-for-you inboxes cannot join a running campaign. {${DFY}}`,
    `- Website Builder top-ups are owner only. {${SITE_CREDITS}}`,
    `- Each website can have one domain at a time. {${SITE_DOMAINS}}`,
    `- Clients never see "Settings", "Members" or "Billing". {${PORTAL}}`,
    `- Clients can't open the settings. {${PORTAL}}`,
    `- Clients see only "Client Portal", "Dashboard", CRM (unless off) and partner-enabled campaigns; never workspace settings, "Members", "Billing". {${PORTAL}}`,
    `- Only Owners buy credits for AI Website Builder. A prompt appears when your balance runs low. {${SITE_CREDITS}}`,
    `- DFY inboxes can't be added to a live campaign. Check the warm-up status first. {${INBOX_FAQ}}`,
    `- You can't add DFY inboxes to a running campaign. {${DFY}}`,
    `- You can't add a DFY inbox to a campaign that's already live. {${DFY}}`,
    `- Prompt top-ups are owner-only, even if you never open Settings. {${SITE_CREDITS}}`,
    `- DFY inboxes don't join a live campaign. {${DFY}}`,
    `- Clients don't see settings. {${PORTAL}}`,
    `- Each website can have no more than one domain. {${SITE_DOMAINS}}`,
    `- Lead location is not supported. {${SITE_DOMAINS}}`,
  ];
  const right = [
    `- Client role has Client Portal, view-only; clients never see campaigns/AI SDR unless partner enables. {${PORTAL}}`,
    `- Clients never see workspace settings, "Members", "Billing" or credits; they keep personal settings. {${PORTAL}}`,
    `- Only Owners buy Website Builder credits from "Settings" > "Billing"; anyone can top up from the prompt. {${SITE_CREDITS}}`,
    `- A DFY inbox still warming up can't be added to a live campaign. {${DFY}}`,
    `- A domain can be assigned to one website at a time. {${SITE_DOMAINS}}`,
    `- Clients see only "Client Portal", "Dashboard", CRM and personal settings; never workspace settings. {${PORTAL}}`,
    `- Only workspace owners can buy credits through "Settings" > "Billing". {${SITE_CREDITS}}`,
    `- Low balance: top up from the prompt; only owners can also buy in "Settings" > "Billing". {${SITE_CREDITS}}`,
    `- A DFY inbox marked "Ready to send" can be added to a live campaign. {${DFY}}`,
    `- Each website can have more than one domain. {${SITE_DOMAINS}}`,
    `- You can change or disconnect a domain under "Manage domain" without contacting support. {${SITE_DOMAINS}}`,
    `- You do not need support to change or disconnect a domain under "Manage domain". {${SITE_DOMAINS}}`,
    `- "Settings" > "Billing" > "Buy credits": only Owners can buy credits here. {${SITE_CREDITS}}`,
    `- They only get widgets built from results they can already see. {${PORTAL}}`,
    `- Clients only see campaigns when their partner enables them. {${PORTAL}}`,
  ];
  assert.deepEqual(refuseSummaryLines({ cannot: wrong, who: right }), {
    kept: { cannot: [], who: right },
    refused: wrong,
  });
});

test("the sections Foreman#370 got wrong are refused, the right ones pass", () => {
  const wrong: [string, string][] = [
    [
      PORTAL,
      section(
        PORTAL,
        '- Clients see "Dashboard", CRM (unless off), personal settings; campaigns/AI SDR only if partner enables; never settings, "Members", "Billing", credits.'
      ),
    ],
    [
      SITE_DOMAINS,
      section(
        SITE_DOMAINS,
        '- Assign: click "Connect website" on the row (or "..." > "Manage domain"), pick the website. One domain per website at a time.'
      ),
    ],
    [SITE_DOMAINS, section(SITE_DOMAINS, "- Counties unsupported.")],
    [SITE_CREDITS, section(SITE_CREDITS, "- Only owners can buy credits.")],
  ];
  for (const [slug, text] of wrong) {
    assert.notDeepEqual(sectionProblems(slug, text), [], text);
  }
  const right: [string, string][] = [
    [
      PORTAL,
      section(
        PORTAL,
        "- Client role sees stats, AI Account Manager chat, help cards; view-only.",
        '- Clients see "Dashboard", CRM (unless off), personal settings; campaigns/AI SDR only if partner enables; never workspace settings, "Members", "Billing", credits.'
      ),
    ],
    [
      SITE_CREDITS,
      section(
        SITE_CREDITS,
        'Get here: "Settings" > "Billing" > "Buy credits" (owners only).',
        "Low balance: top up from the prompt, resend."
      ),
    ],
    [
      DFY,
      section(
        DFY,
        '- New DFY inboxes warm up for 2 weeks: "Status" "Warming up". They can\'t send campaign emails. They can\'t be added to a live campaign.'
      ),
    ],
    [
      INBOX_FAQ,
      section(
        INBOX_FAQ,
        "- Covers sender accounts, inboxes, warmup, domain setup."
      ),
    ],
    [
      SITE_DOMAINS,
      section(
        SITE_DOMAINS,
        'Assign: click "Connect website" on the row, pick the website. A domain goes to one website at a time.',
        '"Manage domain": "Change website", "Disconnect", renewal settings, DNS records.'
      ),
    ],
  ];
  for (const [slug, text] of right) {
    assert.deepEqual(sectionProblems(slug, text), [], text);
  }
});

const LEAD_LIMIT =
  "cold-email-agent/faq/lead-search/why-does-the-lead-limit-prompt-block-sending-when-i-have-leads-and-credits";
const CLEAR_OUT =
  "cold-email-agent/faq/campaigns/does-acquisity-delete-my-leads-automatically";

const LEAD_LIMIT_HEADING = `### Why can’t I add campaign leads when I still have credits? {slug: ${LEAD_LIMIT}}`;
const ROUTES =
  '- Plans: owners use "Settings" > "Billing" > "View plans"; admins use "View plans" in the warning; members "Compare plans"; Client users can\'t change plans.';
const STILL_SENDS =
  "- At 5,000, adding or importing is blocked. Existing campaigns can still send. Nothing is deleted automatically.";

// Wrong lines are Foreman#374's at 7eea8f8e (ENG-21344) or the same claims
// reworded in review. Right lines are written to the Help Centre at Acquisity
// 9b42bbafe194.
test("wrong summary lines from Foreman#374 are dropped", () => {
  const wrong = [
    `- "Clear out old leads" keeps repliers, and targets campaigns 90+ days old only when you have under 2,000 free slots. {${CLEAR_OUT}}`,
    `- Clear out old leads runs only when your workspace is running out of lead space. {${CLEAR_OUT}}`,
    `- "Clear out old leads" removes bounced leads from paused campaigns 90+ days old when under 2,000 free slots. {${CLEAR_OUT}}`,
    `- Clear out old leads only runs when space is tight. {${CLEAR_OUT}}`,
    `- When the agent pauses a campaign, Clear out old leads removes its bounced leads only when you have under 2,000 free slots. {${CLEAR_OUT}}`,
    `- When the agent pauses a campaign, Clear out old leads removes its bounced leads only when you have under 2,000 free slots, regardless of plan. {${CLEAR_OUT}}`,
    `- Owners and Client users use "Settings" > "Billing" > "View plans". {${LEAD_LIMIT}}`,
    `- Change plans in "Settings" > "Billing" > "View plans". {${LEAD_LIMIT}}`,
    `- Owners and admins change plans in "Settings" > "Billing" > "View plans". {${LEAD_LIMIT}}`,
    `- At the limit, existing campaigns stop sending. {${LEAD_LIMIT}}`,
    `- At the limit, existing campaigns stop sending and no new leads can be added. {${LEAD_LIMIT}}`,
    `- At the limit, existing campaigns stop sending, so you won't reach new leads. {${LEAD_LIMIT}}`,
    `- Existing campaigns are no longer sending at the limit. {${LEAD_LIMIT}}`,
    `- Existing campaigns are still unable to send at the limit. {${LEAD_LIMIT}}`,
    `- Members use "View plans" in the warning. {${LEAD_LIMIT}}`,
  ];
  const right = [
    `- "Clear out old leads" removes finished leads from campaigns 90+ days old under 2,000 free slots, and when it pauses a campaign, that campaign's bounced leads however much space you have. {${CLEAR_OUT}}`,
    `- Leads are deleted only when someone deletes them or via the agent's "Clear out old leads". {${CLEAR_OUT}}`,
    `- Only owners use "Settings" > "Billing" > "View plans"; admins use "View plans" in the warning. {${LEAD_LIMIT}}`,
    `- Credits and campaign-lead storage are separate. {${LEAD_LIMIT}}`,
    `- Full storage doesn't stop sending. {${LEAD_LIMIT}}`,
  ];
  assert.deepEqual(
    refuseSummaryLines({ cannot: [...wrong, ...right], who: [] }),
    { kept: { cannot: right, who: [] }, refused: wrong }
  );
});

test("the sections Foreman#374 got wrong are refused, the right ones pass", () => {
  const wrong: string[][] = [
    [
      LEAD_LIMIT,
      section(
        LEAD_LIMIT,
        "- Credits and campaign-lead storage are separate.",
        '- Click "Export", then delete leads or use "Delete all".',
        '- Plans: "Settings" > "Billing" > "View plans".'
      ),
    ],
    [
      LEAD_LIMIT,
      section(
        LEAD_LIMIT,
        STILL_SENDS,
        '- Plans: Settings → Billing → View plans; members "Compare plans" in the warning; Client users can\'t change plans.'
      ),
    ],
    [
      LEAD_LIMIT,
      section(
        LEAD_LIMIT,
        STILL_SENDS,
        '- Owners and admins: "Settings" > "Billing" > "View plans". Members "Compare plans". Client users can\'t change the plan.'
      ),
    ],
    [
      LEAD_LIMIT,
      section(
        LEAD_LIMIT,
        STILL_SENDS,
        '- Owners: "Settings" > "Billing" > "View plans". Admins and members use "Compare plans" in the warning. Client users can change their plan.'
      ),
    ],
    [
      LEAD_LIMIT,
      section(
        LEAD_LIMIT,
        "- At capacity, existing campaigns still cannot send. Nothing is deleted automatically.",
        ROUTES
      ),
    ],
    [
      LEAD_LIMIT,
      section(
        LEAD_LIMIT,
        "- At capacity, existing campaigns still will not send. Nothing is deleted automatically.",
        ROUTES
      ),
    ],
    [
      LEAD_LIMIT,
      section(
        LEAD_LIMIT,
        "- At capacity, existing campaigns are still blocked from sending. Nothing is deleted automatically.",
        ROUTES
      ),
    ],
    [
      LEAD_LIMIT,
      section(
        LEAD_LIMIT,
        STILL_SENDS,
        '- Admins use "View plans" in the warning; members "Compare plans"; Client users can\'t change plans.'
      ),
    ],
    [
      LEAD_LIMIT,
      section(
        LEAD_LIMIT,
        STILL_SENDS,
        ROUTES,
        '- Members use "View plans" in the warning.'
      ),
    ],
    // The real heading says "still" and its slug "sending", so it must not
    // count as the sending line.
    [
      LEAD_LIMIT,
      [
        LEAD_LIMIT_HEADING,
        "- At 5,000, adding or importing is blocked. Nothing is deleted automatically.",
        ROUTES,
      ].join("\n"),
    ],
    [
      CLEAR_OUT,
      section(
        CLEAR_OUT,
        '- No. Leads go only when someone deletes them, or via the agent\'s "Clear out old leads". That action targets campaigns 90+ days old when you have under 2,000 free slots, and repliers are kept.',
        '- Set it to "Never" to stop it. Deletion is permanent.'
      ),
    ],
    [
      CLEAR_OUT,
      section(
        CLEAR_OUT,
        "- Under 2,000 free slots it removes finished leads from old campaigns.",
        "- When the agent pauses a campaign, it keeps the bounced leads."
      ),
    ],
    [
      CLEAR_OUT,
      section(
        CLEAR_OUT,
        "- When the agent pauses a campaign, it removes its bounced leads only when you have under 2,000 free slots."
      ),
    ],
    [
      CLEAR_OUT,
      section(
        CLEAR_OUT,
        "- Under 2,000 free slots it clears finished leads from campaigns 90+ days old and unchanged for 30 days.",
        "- When the agent pauses a campaign, it keeps the bounced leads, regardless of space."
      ),
    ],
    [
      CLEAR_OUT,
      section(
        CLEAR_OUT,
        "- Under 2,000 free slots it clears finished leads from campaigns 90+ days old and unchanged for 30 days.",
        "- When the agent pauses a campaign, it never removes its bounced leads, whatever your space."
      ),
    ],
    [
      CLEAR_OUT,
      section(
        CLEAR_OUT,
        "- When the agent pauses a campaign, it removes its bounced leads only when you have under 2,000 free slots, regardless of plan."
      ),
    ],
  ];
  for (const [slug, text] of wrong) {
    assert.notDeepEqual(sectionProblems(slug, text), [], text);
  }
  const right: string[][] = [
    [
      LEAD_LIMIT,
      [
        LEAD_LIMIT_HEADING,
        "- Sourcing credits and campaign-lead storage are separate; credits add no room.",
        "- Growth warns at 4,000. At 5,000, adding or importing (CSV, lead database, CRM) is blocked. Sending, viewing, replies, export and delete still work. Nothing is auto-deleted.",
        ROUTES,
      ].join("\n"),
    ],
    [
      LEAD_LIMIT,
      section(
        LEAD_LIMIT,
        "- Existing campaigns keep sending. The limit does not automatically delete anything. Full storage does not cause existing campaigns to stop sending.",
        "- Members can't use View plans; an owner or admin makes the change.",
        '- Workspace owners: Settings → Billing → View plans. Owners and admins: "View plans" in the campaign-lead warning. Members: "Compare plans" there. Clients cannot change plans.'
      ),
    ],
    [
      CLEAR_OUT,
      section(
        CLEAR_OUT,
        "- No. Acquisity never deletes campaign leads on its own to make room.",
        "- The agent's \"Clear out old leads\": under 2,000 free slots it removes fully emailed or bounced leads from paused or completed campaigns 90+ days old and unchanged for 30 days; when it pauses a campaign it can remove that campaign's bounced leads, however much space you have. Repliers are kept."
      ),
    ],
    [
      CLEAR_OUT,
      section(
        CLEAR_OUT,
        '- Not on its own. The one exception is the agent\'s "Clear out old leads", when your workspace is running out of lead space.',
        "- Clearing space: under 2,000 free lead slots, it removes people who got every email or bounced, from paused or completed campaigns 90+ days old and unchanged for 30 days.",
        "- Pausing a campaign: when it pauses a campaign, it can also remove that campaign's bounced leads, however much space you have."
      ),
    ],
    [
      CLEAR_OUT,
      section(
        CLEAR_OUT,
        "- Under 2,000 free slots it clears finished leads from campaigns 90+ days old and unchanged for 30 days.",
        "- It can remove bounced leads of campaigns it pauses, whatever your space."
      ),
    ],
    [
      CLEAR_OUT,
      section(
        CLEAR_OUT,
        "- Under 2,000 free slots it clears finished leads from campaigns 90+ days old and unchanged for 30 days.",
        "- When the agent pauses a campaign, it can remove that campaign's bounced leads regardless of the 2,000 free-slot check, or regardless of remaining space."
      ),
    ],
  ];
  for (const [slug, text] of right) {
    assert.deepEqual(sectionProblems(slug, text), [], text);
  }
});

// The run after Foreman#377 refused the clear-out section three times and
// stopped (Foreman run 46032903138): twice on a pause clause that named low
// space, once on a missing pause clause. Its log didn't show the section, so
// the right lines are the model's own from Foreman#374 at df7fe03a and
// rewordings of the same rule, not that run's output.
test("correct clear-out wordings pass, so a regeneration can finish", () => {
  const right: string[] = [
    section(
      CLEAR_OUT,
      '- Leads go only when someone in your workspace deletes them (e.g. "Delete all" on the "Leads" tab), or when the Cold Email Agent\'s "Clear out old leads" action runs.',
      '- "Clear out old leads" exists where "Settings" > "Cold Email Agent" shows "Agent mode":',
      '  - "Clearing space:" with under 2,000 free lead slots, it can queue removal of leads who got every email or bounced, from paused or completed campaigns at least 90 days old and unchanged for 30 days, oldest first.',
      '  - "Pausing a campaign:" it can also remove that campaign\'s bounced leads, whatever your space.',
      '  - "Never removed:" repliers, leads mid-sequence, leads not yet emailed.'
    ),
    section(
      CLEAR_OUT,
      "- Under 2,000 free lead slots it removes finished or bounced leads from old paused or completed campaigns.",
      "- When it pauses a campaign, it can also remove that campaign's bounced leads, even when there is plenty of free space."
    ),
    section(
      CLEAR_OUT,
      "- When it pauses a campaign, it can also remove that campaign's bounced leads (not repliers)."
    ),
    section(
      CLEAR_OUT,
      "- When it pauses a campaign, it can remove that campaign's bounced leads, even with more than 2,000 free slots."
    ),
    section(
      CLEAR_OUT,
      "- When it pauses a campaign, it can remove its bounced leads, not only when you have under 2,000 free slots."
    ),
    section(
      CLEAR_OUT,
      "- When pausing a campaign, the agent can remove only that campaign's bounced leads, regardless of remaining space, even above 2,000 free slots."
    ),
    section(
      CLEAR_OUT,
      "- When it pauses a campaign, even with 5,000 free slots, it can remove that campaign's bounced leads."
    ),
    section(
      CLEAR_OUT,
      "- It removes old leads when you have fewer than 2,000 free slots, and bounced leads when it pauses a campaign."
    ),
    section(
      CLEAR_OUT,
      "- When it pauses a campaign, it removes its bounced leads, and when you have fewer than 2,000 free slots it also clears old finished leads."
    ),
  ];
  for (const text of right) {
    assert.deepEqual(sectionProblems(CLEAR_OUT, text), [], text);
  }
  const kept = [
    `- If lead storage is full, adding or importing leads is blocked until there is room. {${CLEAR_OUT}}`,
    `- "Clear out old leads" removes old leads under 2,000 free slots, and bounced leads when the agent pauses a campaign. {${CLEAR_OUT}}`,
  ];
  assert.deepEqual(refuseSummaryLines({ cannot: kept, who: [] }), {
    kept: { cannot: kept, who: [] },
    refused: [],
  });
});

test("a pause case that keeps bounced leads or needs low space is refused", () => {
  const first =
    "- Under 2,000 free slots it clears finished leads from old campaigns.";
  const wrong = [
    "- When it pauses a campaign, its bounced leads won't be removed.",
    "- When it pauses a campaign, bounced leads aren't deleted.",
    "- When it pauses a campaign, it keeps bounced leads rather than removing them.",
    "- When it pauses a campaign, it never queues removal of its bounced leads.",
    "- When it pauses a campaign, it does not ever remove bounced leads.",
    "- When the agent pauses a campaign, it cannot remove that campaign's bounced leads, whatever your space.",
    "- When the agent pauses a campaign, it can remove its bounced leads only if you have fewer than 2,000 free slots.",
    "- When it pauses a campaign, it can remove that campaign's bounced leads.\n- Pausing a campaign removes bounced leads only when you have under 2,000 free slots.",
    "- When it pauses a campaign it removes bounced leads, even when space is low, but only under 2,000 free slots.",
  ];
  for (const line of wrong) {
    const text = section(CLEAR_OUT, first, line);
    assert.notDeepEqual(sectionProblems(CLEAR_OUT, text), [], text);
  }
  const summaries = [
    `- Leads are only cleared when you have under 2,000 free slots. {${CLEAR_OUT}}`,
    `- The agent's clean-up targets campaigns 90+ days old only when you have under 2,000 free slots. {${CLEAR_OUT}}`,
    `- The Cold Email Agent prunes leads from campaigns 90+ days old only when you have under 2,000 free slots. {${CLEAR_OUT}}`,
    `- Old leads are removed only under 2,000 free slots, even if your plan has room to upgrade. {${CLEAR_OUT}}`,
    `- "Clear out old leads" removes leads only when lead storage is full. {${CLEAR_OUT}}`,
    `- "Clear out old leads" removes leads only when your workspace is nearly full. {${CLEAR_OUT}}`,
    `- "Clear out old leads" removes leads only when storage is running low. {${CLEAR_OUT}}`,
  ];
  assert.deepEqual(refuseSummaryLines({ cannot: summaries, who: [] }), {
    kept: { cannot: [], who: [] },
    refused: summaries,
  });
});

test("the log of a refused distillation shows each refused section's text", () => {
  const bad = section(CLEAR_OUT, "- Leads are never deleted.");
  const sections = new Map([
    [CLEAR_OUT, bad],
    [MEET, section(MEET, "- Use Google Meet.")],
  ]);
  assert.equal(
    refusedSections([CLEAR_OUT, MEET], sections),
    `  refused section ${CLEAR_OUT}:\n${bad}`
  );
});
