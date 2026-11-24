import assert from "node:assert/strict";
import test from "node:test";

import { defaultGateDeps } from "./widget-egress.js";

const LIVE = Boolean(
  process.env.WIDGET_COMPOSER_LIVE &&
    process.env.CLIPROXY_BASE_URL &&
    process.env.CLIPROXY_API_KEY
);
const RUNS = 10;
const TEAMMATE = /Ervin/;
const ASKER_CREDITED =
  /\bby you\b|\byou (?:made|changed|removed|added|edited|updated|created|re-added|merged)\b|\byour (?:changes|edits)\b/i;

test("the composer names the teammate who made a change instead of crediting the asker", {
  skip: !LIVE && "set WIDGET_COMPOSER_LIVE with the CLI Proxy keys",
}, async () => {
  const question =
    "Before the merge I tried to change his email from stephen@ecomow.com to stephen@greenformlandscapes.com and it kept going back to the old one. Why did that happen, and who in my workspace is allowed to edit contact emails?";
  const findings = {
    confidence: "high" as const,
    facts: [
      {
        claim:
          "On 5 October 2026 Ervin Worden removed stephen@ecomow.com from Stephen Gault at 17:05 and added it back at 17:10.",
      },
      {
        claim:
          "Ervin Worden created a second Stephen Gault with stephen@greenformlandscapes.com at 18:23 and merged the two people at 18:36 on 5 October 2026.",
      },
      {
        claim:
          "Both workspace members are Owners, and Owners may add, edit or remove a person's emails.",
      },
    ],
    needsHuman: false,
    recommendation:
      "The email did not revert on its own: the history shows each change made in turn. Any Owner can edit contact emails from the person's page.",
  };
  const replies = await Promise.all(
    Array.from({ length: RUNS }, () =>
      defaultGateDeps.compose({
        findings,
        organizationName: "Ervin Worden's Workspace",
        question,
        recordingOffered: false,
      })
    )
  );
  for (const reply of replies) {
    assert.match(reply, TEAMMATE);
    assert.doesNotMatch(reply, ASKER_CREDITED);
  }
});
