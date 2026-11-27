import assert from "node:assert/strict";
import { test } from "node:test";
import {
  correctionNotes,
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
  for (const { slug } of GUIDE_CORRECTIONS) {
    assert.ok(slug in PRODUCT_GUIDE_ARTICLES, slug);
  }
});

// The wrong lines are copied from Foreman#353 at d9475c02 (ENG-21059); the
// right ones from main's guide at Acquisity 8ad1a87ad0b1.
test("the sections Foreman#353 got wrong are refused", () => {
  const wrong: [string, string][] = [
    [
      CLIENT_TOOL,
      section(
        CLIENT_TOOL,
        'Get here: left sidebar "Client Portal"',
        'Clients see only "Client Portal", "Dashboard", CRM, partner-enabled campaigns/AI SDR; make them Member for more.'
      ),
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

test("main's right wording for the same articles passes", () => {
  const right: [string, string][] = [
    [
      CLIENT_TOOL,
      section(
        CLIENT_TOOL,
        'Get here: "Settings" > "Members"',
        '- Expected. Clients see only "Client Portal", "Dashboard", CRM (unless off), and Cold Email Agent/AI SDR if the partner enabled them.'
      ),
    ],
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
  ];
  assert.deepEqual(
    refuseSummaryLines(AI_SDR_FAQ, { cannot: lines.slice(0, 2), who: [] }),
    { kept: { cannot: [lines[1]], who: [] }, refused: [lines[0]] }
  );
  assert.deepEqual(
    refuseSummaryLines(CALLING, { cannot: lines.slice(2, 4), who: [lines[4]] }),
    { kept: { cannot: [], who: [lines[4]] }, refused: [lines[2], lines[3]] }
  );
  assert.deepEqual(
    refuseSummaryLines("crm/deals", { cannot: lines, who: [] }),
    {
      kept: { cannot: lines, who: [] },
      refused: [],
    }
  );
});
