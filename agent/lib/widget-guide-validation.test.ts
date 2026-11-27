import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answerWords,
  assertGuideSections,
  assertOwnAnswers,
  frontmatterField,
  plainDashes,
  shortAnswers,
  shrunkAnswers,
} from "./widget-guide-validation.js";
import {
  PRODUCT_GUIDE,
  PRODUCT_GUIDE_ARTICLES,
} from "./widget-product-guide.js";

const MISSING = /missing slugs: second/u;
const POINTERS =
  /sections answer with another article: dashboard\/faq\/sample, offer-creator\/faq\/count$/u;
const DUPLICATE = /duplicate slug: first/u;
const UNEXPECTED = /unexpected slug: other/u;
const INVALID = /invalid heading: ### Second; missing slugs: second/u;

test("guide coverage rejects missing, duplicate, unexpected and invalid sections", () => {
  const first = "### First {slug: first}";
  const second = "### Second {slug: second}";
  const slugs = ["first", "second"];
  assert.doesNotThrow(() => assertGuideSections(`${first}\n${second}`, slugs));
  assert.throws(() => assertGuideSections(first, slugs), MISSING);
  assert.throws(
    () => assertGuideSections(`${first}\n${first}\n${second}`, slugs),
    DUPLICATE
  );
  assert.throws(
    () =>
      assertGuideSections(
        `${first}\n${second}\n### Other {slug: other}`,
        slugs
      ),
    UNEXPECTED
  );
  assert.throws(
    () => assertGuideSections(`${first}\n### Second`, slugs),
    INVALID
  );
  // Check the committed artifact without regenerating it or making model calls.
  assert.doesNotThrow(() =>
    assertGuideSections(PRODUCT_GUIDE, Object.keys(PRODUCT_GUIDE_ARTICLES))
  );
});

test("front matter titles read folded block scalars, not the >- marker", () => {
  const front =
    "title: >-\n  Can I prevent the AI SDR from auto-booking\n  into the client's calendar?\ndescription: Short.";
  assert.equal(
    frontmatterField(front, "title"),
    "Can I prevent the AI SDR from auto-booking into the client's calendar?"
  );
  assert.equal(frontmatterField(front, "description"), "Short.");
  assert.equal(frontmatterField('title: "Quoted"', "title"), "Quoted");
  assert.equal(frontmatterField("other: x", "title"), "");
  assert.equal(
    frontmatterField(
      "title: >-\n  First part\n\n  second part\nnext: y",
      "title"
    ),
    "First part second part"
  );
});

test("em dashes become commas between words and a hyphen when they stand alone", () => {
  assert.equal(
    plainDashes("A dash (\u2014) means not enough data yet \u2014 check back."),
    "A dash (-) means not enough data yet, check back."
  );
  assert.equal(
    plainDashes('shows "\u2014" or word\u2014word'),
    'shows "-" or word, word'
  );
  // A dash at a line edge must not join the next line, such as a section heading.
  assert.equal(
    plainDashes("Status: —\n### Next {slug: next}"),
    "Status:, \n### Next {slug: next}"
  );
});

test("a section that answers with another article's slug is refused", () => {
  // Shapes seen in Foreman#274's guide (ENG-20311).
  const guide = [
    "### Where did my sample data go? {slug: dashboard/faq/sample}",
    "Same as: dashboard",
    "### How many offers? {slug: offer-creator/faq/count}",
    "Same as offer-creator.",
    "Same as slug cold-email-agent/faq/billing-domains/redirect.",
    "  * Same as: dashboard",
    "### Campaign settings {slug: cold-email-agent/settings}",
    '- Who takes the calls: "Same as default" or "This campaign only".',
    "Same as the monthly plan: $20.",
  ].join("\n");
  assert.throws(() => assertOwnAnswers(guide), POINTERS);
  assert.doesNotThrow(() =>
    assertOwnAnswers(guide.split("\n").slice(6).join("\n"))
  );
});

test("a long article answered in a line is short, and a short article or a full answer is not", () => {
  // Foreman#274's guide at 30052833: Client Portal came out as "View-only." (ENG-20575).
  const guide = [
    "### Client Portal {slug: client-portal}",
    'Get here: "Client Portal"',
    "View-only.",
    "### Voice tone {slug: sca/voice}",
    "No, text only.",
    "### Sales Call Analyzer {slug: sca}",
    'Get here: In the left sidebar, click "Sales Call Analyzer"',
    "- Upload a recording or paste a transcript of 175 words or more, then",
    "  read the scores, the summary and the coaching notes for each call.",
  ].join("\n");
  const long = "x".repeat(2000);
  assert.deepEqual(
    shortAnswers(guide, [
      { slug: "client-portal", text: long },
      { slug: "sca/voice", text: "Text only." },
      { slug: "sca", text: long },
      { slug: "missing", text: long },
    ]),
    ["client-portal", "missing"]
  );
  assert.deepEqual(
    [...answerWords(guide)],
    [
      ["client-portal", 1],
      ["sca/voice", 3],
      ["sca", 26],
    ]
  );
});

test("a how-to with many steps answered in a line is short, even when its page is short", () => {
  const steps = [
    "1. Log in.",
    "2. Open DNS.",
    "3. Add the record.",
    "4. Save.",
  ].join("\n");
  const guide = [
    "### Connect a Porkbun domain {slug: porkbun}",
    "Add the DNS records at Porkbun.",
    "### Connect a Cloudflare domain {slug: cloudflare}",
    "- Log in, open DNS for the domain, add the CNAME and TXT records the",
    "  Partner Panel shows, turn the proxy off, then click Verify Domain.",
  ].join("\n");
  assert.deepEqual(
    shortAnswers(guide, [
      { slug: "porkbun", text: steps },
      { slug: "cloudflare", text: steps },
    ]),
    ["porkbun"]
  );
});

test("a section with under four fifths of main's words has shrunk, and a new or near-equal one has not", () => {
  // Foreman#374 at dc68cdb2: Calling and Texting went from 216 words to 107 (ENG-21319).
  const words = (count: number) => Array.from({ length: count }, () => "w").join(" ");
  const main = [
    "### Calling and Texting {slug: crm/calling-and-texting}",
    'Get here: "People"',
    words(20),
    "### People {slug: crm/people}",
    words(10),
    "### Deals {slug: crm/deals}",
    words(10),
  ].join("\n");
  const regenerated = [
    "### Calling and Texting {slug: crm/calling-and-texting}",
    'Get here: "People" > "Call"',
    words(15),
    "### People {slug: crm/people}",
    words(8),
    "### Deals {slug: crm/deals}",
    words(30),
    "### Dialling {slug: crm/dialling}",
    words(1),
  ].join("\n");
  assert.deepEqual(shrunkAnswers(regenerated, main), [
    { now: 15, slug: "crm/calling-and-texting", was: 20 },
  ]);
});
