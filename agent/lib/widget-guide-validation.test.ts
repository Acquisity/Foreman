import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertGuideSections,
  frontmatterField,
  plainDashes,
} from "./widget-guide-validation.js";
import {
  PRODUCT_GUIDE,
  PRODUCT_GUIDE_ARTICLES,
} from "./widget-product-guide.js";

const MISSING = /missing slugs: second/u;
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
});
