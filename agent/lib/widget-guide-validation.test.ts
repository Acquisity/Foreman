import assert from "node:assert/strict";
import { test } from "node:test";
import { assertGuideSections } from "./widget-guide-validation.js";
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
