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
];

export default defineEval({
  description:
    "ENG-20988: the extraction pass lists no question the reply asked the customer, nothing only the customer knows and nothing the investigator did not say it couldn't check, in 10 of 10 runs of five replayed write-ups, while a failed read and a Help Centre gap still file in 10 of 10.",
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
        "no over-listed item in the five cases, and every control still files"
      )
    );
  },
  timeoutMs: 1_200_000,
});
