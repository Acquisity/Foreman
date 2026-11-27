import assert from "node:assert/strict";
import { test } from "node:test";
import { guideCallKey } from "./widget-guide-cache.js";
import {
  batchProblems,
  correctionKeyInputs,
  correctionNotes,
  correctionPath,
  GUIDE_CORRECTIONS,
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
        "- Calls and texts are blocked for Do not contact status and the do-not-contact list. A STOP reply blocks texts only; calls are not affected."
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
        "- Do not contact blocks calls and texts, while STOP leaves calls unaffected."
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
