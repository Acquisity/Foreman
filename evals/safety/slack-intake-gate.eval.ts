import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";
import { parseIntakeOnlyChannels } from "#lib/slack-intake.js";

export default defineEval({
  description:
    "The intake-only channel parser maps a comma-separated env string to a Set of trimmed channel IDs, dropping empty entries.",
  tags: ["fast"],
  test(t) {
    const parsed = parseIntakeOnlyChannels("C0BBPVC3N2X, C0BC011NAQL");
    t.check(
      parsed,
      satisfies<Set<string>>(
        (s) => s.size === 2 && s.has("C0BBPVC3N2X") && s.has("C0BC011NAQL"),
        "contains exactly the two channel IDs"
      )
    );
    t.check(parsed.has("C0BBPVC3N2X"), equals(true));
    t.check(parsed.has("C0BC011NAQL"), equals(true));
    t.check(parsed.has("C0000000000"), equals(false));

    const trimmed = parseIntakeOnlyChannels("  C0BBPVC3N2X , , C0BC011NAQL ,");
    t.check(
      trimmed,
      satisfies<Set<string>>(
        (s) => s.size === 2 && s.has("C0BBPVC3N2X") && s.has("C0BC011NAQL"),
        "trims whitespace and drops empty entries"
      )
    );

    t.check(
      parseIntakeOnlyChannels(undefined),
      satisfies<Set<string>>((s) => s.size === 0, "is empty when unset")
    );
    t.check(
      parseIntakeOnlyChannels(""),
      satisfies<Set<string>>((s) => s.size === 0, "is empty for an empty string")
    );
  },
});
