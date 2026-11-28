import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { verifiedWidgetContext as scope } from "../../agent/lib/widget.fixture.js";
import { extractWidgetFindings } from "../../agent/lib/widget-extract.js";
import type { WidgetFindings } from "../../agent/lib/widget-findings.js";

const RUNS = 10;
type Unchecked = NonNullable<WidgetFindings["unchecked"]>;

// ENG-20988: write-ups rebuilt from five replies whose extraction filed gap
// tickets the reply never needed (names and domains swapped for neutral ones).
// Each case's `allowed` says what may come back as unchecked; anything else is over-listing.
const NOTHING = (unchecked: Unchecked) => unchecked.length === 0;
// ENG-20555's reply did say it couldn't check why the list check failed, so only that may file;
// any tie to the earlier checkbox problem, or any other item, is over-listed.
const LIST_CHECK =
  /\blist check\b|\bimport preview\b|\bcheck(ing)? (of )?(the |your )?(csv |lead )?list\b/iu;
const CAUSE = /\b(why|cause|reason|fail)/iu;
const TIED =
  /checkbox|earlier|previous|both|link|relat|connect|share|same|empty|imported/iu;
const LIST_CHECK_ONLY = (unchecked: Unchecked) =>
  unchecked.every(
    (gap) =>
      LIST_CHECK.test(gap.fact) && CAUSE.test(gap.fact) && !TIED.test(gap.fact)
  );
const CHARGE = /charge|refund/iu;
const PARTIAL = /partial/iu;
const PLAYBOOKS = /playbook/iu;
// ENG-21513: each replayed case may file only the item that was a real open question on our side;
// anything else, however worded, is the screen, the email or a future outcome over-listed.
const FUTURE =
  /\bwill\b|going to|succe|outcome|go(es)? through|year[- ]end|future|project|forecast/iu;
const WHY_PLAN_NONE = /^why\b.*\b(plan|subscription)\b/iu;
const END_DATE_OR_PRICE = /end date|price|cost/iu;
const PRICE = /price|cost/iu;
const only = (keep: (fact: string) => boolean) => (unchecked: Unchecked) =>
  unchecked.every((gap) => keep(gap.fact) && !FUTURE.test(gap.fact));
const LINE_ITEMS = /line item|charge|invoice/iu;

const CASES = [
  {
    allowed: NOTHING,
    investigatorText:
      "The customer asked whether they can email support. The Help Centre guide says there is no support email address or phone line: support runs entirely through chat, which they can also reach from their name at the bottom of the sidebar > Feedback, or from the chat bubble. Their refund request for the domain charge is already with billing. I told them to keep writing in this chat and to send anything else they have about the charge, such as an email from us or a screenshot of where they saw a renewal. I can't promise a refund, an amount or a date.",
    name: "ENG-20882 support by email, answered in full",
    question: "Can I send an email to support?",
  },
  {
    allowed: LIST_CHECK_ONLY,
    investigatorText:
      'The customer hit a "We couldn\'t check your list (Something went wrong on our side. Try again in a moment.)" error on the CSV import preview, after earlier being unable to tick the "Include leads already emailed in previous campaigns" checkbox. Nothing from this attempt was saved: I see no import runs or failed jobs in the last 7 days, no leads stored in the campaign, and no lead credits used. No known issue matches. I couldn\'t see why the list check failed. I told them to wait about a minute and press "Try again"; if it still fails, go back to "Review values", click "Preview import" again, and import a small test file of 10 to 20 rows to see whether the file or the check is the problem. If both fail, they should send the exact wording on the screen or a new screenshot.',
    name: "ENG-20555 list check failed after an earlier checkbox problem",
    question:
      "Ok, now I am not even getting the same screen but you see how it says: We couldn't check your list (Something went wrong on our side. Try again in a moment.) Try again button. I am going to press that.",
  },
  {
    allowed: NOTHING,
    investigatorText:
      "I read the workspace's websites and found no recorded build failure on any of them. Six of the sites share the same name, \"New AI Website\", so I can't tell which site the customer means. I asked the customer which website the build is failing on and roughly when they last edited or published it, and suggested a screenshot of the failure message in the builder or the Record my screen button.",
    name: "ENG-20984 which site's build failed, asked the customer",
    question: "My website build failed. Why did it fail and how do I fix it?",
  },
  {
    allowed: NOTHING,
    investigatorText:
      "When I checked at 05:04 UTC today, shop.example.com had no public DNS records at all, so either they haven't been added or they haven't reached public DNS yet. HTTPS couldn't be checked yet because the domain doesn't point anywhere public. On the Harbor site, shop.example.com is saved as its custom domain and assigned to the site, but it shows as not verified. The domain wasn't bought through Acquisity, so its records aren't set up automatically. The site has never had a successful publish, so even with correct DNS visitors would see a 404 for now. No platform fault was recorded. The customer should open Sites > Websites > Domains > Manage domain, add the records shown there where the DNS for example.com is managed (check the nameservers if that isn't where they registered it), then publish the site. If it's still unverified after 24 hours, they should contact support with screenshots of the records in the app and at their DNS provider.",
    name: "ENG-20986 custom domain with no public DNS records yet",
    question:
      "My domain shop.example.com on my Harbor site isn't loading. Is the DNS set up right and does HTTPS work?",
  },
  {
    allowed: NOTHING,
    investigatorText:
      "The CRM search for first names starting with \"Am\" matched 10 people, all named Amara Stone, each with a different email saved: amara1@example.com, amara2@example.com, amara3@example.com, amara4@example.com, amara5@example.com, amara6@example.com, amara7@example.com, amara8@example.com, amara9@example.com and amara10@example.com. The result was cut off, so there may be more matches that aren't in this list. I can't tell which of these the customer means. I asked for her last name or the company she works for.",
    name: "ENG-20987 which CRM contact, asked the customer",
    question:
      "I'm looking for a contact in my CRM but I only remember her first name starts with Am. Can you find who that is and what email I have saved for her?",
  },
  // ENG-21513: three replies from 27 Nov whose extraction still filed what the reply asked the customer,
  // and outcomes nobody can know before they happen. Their other items are judged by triage, so only these fail.
  {
    allowed: only((fact) => WHY_PLAN_NONE.test(fact)),
    investigatorText:
      'The billing read shows the plan as none, no active subscription, and no pending upgrade or downgrade. The last Pro invoice was $185, paid on 29 Oct 2026, with a period end of 29 Nov 2026, and each domain add-on has a cancellation date with a period end of 29 Nov 2026. There are no unpaid invoices. That is why the customer doesn\'t see "Change plan": there is no plan to change, so they need to start a new one. I can\'t confirm why the Pro plan now reads as none, and I can\'t see what the Plan section on their billing screen shows them, so I told them to open Settings > Billing, click "Upgrade" or "Enable Acquisity" in the Plan section and choose Growth, and if neither button appears, to tell me what the Plan section shows or send a screenshot.',
    name: "ENG-21513 asked what the Plan section shows",
    question: "why i cant downgrade to growth",
  },
  {
    allowed: only((fact) => END_DATE_OR_PRICE.test(fact)),
    investigatorText:
      "The orders read shows end warnings sent on 12 November for all six domains: five at the 30-day checkpoint with an end date of 2 December 2026, and one at the expired checkpoint with an end date of 2 November 2026. The domains record in the same read shows all six active with an expiry of 29 December 2026, auto-renew on and a billing label of Paid. All 18 inboxes are connected and active, and no cancellations or unpaid flags are recorded. No renewal price or renewal date is recorded for any domain, and no renewal notice is showing in the app. I can't confirm the renewals will go through with the registrar, or which end date the email was referring to, and I can't see what the customer's email actually said. I asked them to check each domain's billing badge under Settings > Billing > Email domains and inboxes, and to paste the wording of the email or attach a screenshot, with the domains and the date it names.",
    name: "ENG-21513 asked for the email, and whether renewals will go through",
    question:
      "i had an email saying domains need replacing or renewing by year end but im confused",
  },
  {
    allowed: only((fact) => PRICE.test(fact)),
    investigatorText:
      "The workspace has 6 managed domains with 3 inboxes each, all active. In the 14-day domain review (13 to 26 November), 3 domains carry the Few replies flag: one with 900 sent and 0 replies, one with 900 sent and 1 reply, and one with 900 sent and 2 replies. The other three have no flag, at 2.6%, 1.5% and 0.67% reply rates. No domain was flagged for bounces or low warm-up, there are no open deliverability alerts, DNS passes on all 6 domains and every inbox shows 100% health. This is a 14-day snapshot, so it can't tell what the numbers will be at year end. All 6 domains expire on 29 December 2026 with auto-renew on and billing showing Paid, but the records show no renewal price or outcome, so I can't confirm the renewals will go through. I asked whether they meant replacing the flagged domains or the domains that expire at year end.",
    name: "ENG-21513 year-end numbers and renewals going through",
    question: "need to know how many domains need replacing at year end",
  },
  // Controls: a read that failed, and a product question the Help Centre doesn't explain, still file.
  {
    allowed: (unchecked: Unchecked) =>
      unchecked.some(
        (gap) =>
          gap.area === "billing" && gap.kind === "tool" && CHARGE.test(gap.fact)
      ),
    investigatorText:
      "I read the workspace's plan: it is on Pro and active. The stripe section could not be read (it timed out), so I couldn't confirm the latest charge or whether a refund was issued.",
    name: "control: billing read failed",
    question: "Was I charged twice this month?",
  },
  {
    allowed: (unchecked: Unchecked) =>
      unchecked.some((gap) => gap.kind === "docs" && PARTIAL.test(gap.fact)),
    investigatorText:
      "I read the order: 3 of its 5 domains are active and 2 are still being set up, and the order shows as partial. The Help Centre doesn't explain what a partial domain order means, so I couldn't tell the customer what partial means or whether they need to do anything.",
    name: "control: Help Centre doesn't explain it",
    question: "What does partial mean on my domain order?",
  },
  {
    allowed: (unchecked: Unchecked) =>
      unchecked.some((gap) => gap.kind === "docs" && PLAYBOOKS.test(gap.fact)),
    investigatorText:
      "I can't make changes to the account. I couldn't find a campaign playbooks setting in the Help Centre, so I couldn't confirm that campaign playbooks exists or whether it can be turned on for this workspace. No known issue matches, and nothing in the workspace explains the API message the customer mentioned. The AI SDR Knowledge Base is 3,152 characters and covers one offer, and there are no saved rules. I gave them the ways to get different AI SDR instructions per campaign: a separate workspace with its own Knowledge Base, facts labelled with the campaign name, or Rules under Settings > AI SDR Agent. I asked them to paste the exact request and the full error text if they want to chase the API message.",
    name: "control: ENG-21513 campaign playbooks the Help Centre doesn't cover",
    question: "campaign playbooks",
  },
  {
    allowed: (unchecked: Unchecked) =>
      unchecked.some(
        (gap) =>
          gap.area === "billing" &&
          gap.kind === "tool" &&
          LINE_ITEMS.test(gap.fact)
      ),
    investigatorText:
      "The billing read shows the plan is active, but the invoices section timed out, so I couldn't see the line items of the latest invoice or what the charge on 29 Oct was for. I asked the customer to send the invoice PDF or a screenshot of it so I can explain the charge.",
    name: "control: ENG-21513 a failed read still files when the reply also asked the customer",
    question: "what was the $185 charge on 29 Oct for?",
  },
];

export default defineEval({
  description:
    "ENG-20988 and ENG-21513: the extraction pass lists no question the reply asked the customer, nothing only the customer knows, no outcome that can only be known later and nothing the investigator did not say it couldn't check, in 10 of 10 runs of eight replayed write-ups, while a failed read and two Help Centre gaps still file in 10 of 10.",
  tags: ["widget"],
  async test(t) {
    if (!(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN)) {
      t.skip("missing AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN for the kb slot");
    }
    const misses: string[] = [];
    for (const c of CASES) {
      let clean = 0;
      for (let i = 0; i < RUNS; i += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: each run is a separate real extraction, counted one by one.
        const out = await extractWidgetFindings({
          investigatorText: c.investigatorText,
          question: c.question,
          scope,
        });
        const unchecked = out?.unchecked ?? [];
        if (out && c.allowed(unchecked)) {
          clean += 1;
        } else {
          misses.push(`${c.name}: ${JSON.stringify(out ? unchecked : null)}`);
        }
      }
      t.log(`${c.name}: ${clean} of ${RUNS}`);
    }
    for (const miss of misses) {
      t.log(miss);
    }
    await t.require(
      misses.length === 0,
      satisfies(
        Boolean,
        "no over-listed item in any case, and every control still files"
      )
    );
  },
  timeoutMs: 1_200_000,
});
