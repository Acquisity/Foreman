import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { verifiedWidgetContext as scope } from "../../agent/lib/widget.fixture.js";
import { extractWidgetFindings } from "../../agent/lib/widget-extract.js";

const RUNS = 10;
const DNS = /\bdns\b/iu;

// ENG-20478 round 2: a DNS fact from an inboxes question was filed under the
// website area. Sending-domain DNS is inboxes; a site's custom-domain DNS is website.
const CASES = [
  {
    area: "inboxes",
    investigatorText:
      "I read the workspace's inboxes. 54 sending accounts are active. What I couldn't check: the DNS records of the sending domains and their live sending health.",
    question: "Are my sending inboxes connected and healthy?",
  },
  {
    area: "website",
    investigatorText:
      "I read the website: it is published. What I couldn't check: whether the custom domain's DNS points at the site.",
    question: "Why isn't my website's custom domain working?",
  },
];

export default defineEval({
  description:
    "ENG-20478: the extraction pass files an unchecked DNS fact under the area of its question, sending-domain DNS under inboxes and a site's custom-domain DNS under website, in 10 of 10 runs each.",
  tags: ["widget"],
  async test(t) {
    if (!(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN)) {
      t.skip("missing AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN for the kb slot");
    }
    const misses: string[] = [];
    for (const c of CASES) {
      for (let run = 0; run < RUNS; run += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: each run is a separate real extraction, counted one by one.
        const out = await extractWidgetFindings({
          investigatorText: c.investigatorText,
          question: c.question,
          scope,
        });
        const dns = (out?.unchecked ?? []).filter((gap) => DNS.test(gap.fact));
        if (dns.length === 0 || dns.some((gap) => gap.area !== c.area)) {
          misses.push(`${c.area}: ${JSON.stringify(out?.unchecked ?? null)}`);
        }
      }
    }
    t.log(
      `${CASES.length * RUNS - misses.length} of ${CASES.length * RUNS} extractions filed DNS under the right area`
    );
    for (const miss of misses) {
      t.log(miss);
    }
    await t.require(
      misses.length === 0,
      satisfies(Boolean, "every DNS fact is filed under its question's area")
    );
  },
  timeoutMs: 600_000,
});
