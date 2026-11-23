import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import { scanIdentifiers } from "./widget-egress.js";
import {
  ANSWER_HERE,
  personInvite,
  ticketInsteadOfHandoff,
  withAnswerHere,
} from "./widget-handoff.js";

const ticket = { summary: "The customer asked for a person.", title: "Person" };
const ids = { runId: "run-1" };
const filer = (result: object) => {
  const calls: unknown[] = [];
  const file = ((...args: unknown[]) => {
    calls.push(args);
    return Promise.resolve(result);
  }) as never;
  return { calls, file };
};
const PROMISES_A_PERSON = /teammate|person|soon|hours?\b/iu;
const filed = { existing: false, identifier: "ENG-1", refund: false, url: "u" };

test("the customer-facing lines promise only where the answer will come, and carry nothing the scans refuse", () => {
  const invite = personInvite({ conversationId: "c", runId: "r" });
  for (const line of [ANSWER_HERE, invite]) {
    const { candidates, internal } = scanIdentifiers(line);
    assert.deepEqual(internal, []);
    assert.deepEqual(Object.values(candidates).flat(), []);
    assert.ok(!PROMISES_A_PERSON.test(line));
  }
});

test("the answer-comes-here line follows a reply once per conversation", () => {
  assert.equal(withAnswerHere("Done.", undefined), `Done.\n\n${ANSWER_HERE}`);
  assert.equal(
    withAnswerHere("Done.", [
      { role: "assistant", text: `Hi. ${ANSWER_HERE}` },
    ]),
    "Done."
  );
  assert.equal(
    withAnswerHere("Done.", [{ role: "customer", text: ANSWER_HERE }]),
    `Done.\n\n${ANSWER_HERE}`
  );
});

test("a customer turn files the ticket; a teammate's run and a caller with no filer file nothing", async () => {
  const customer = filer(filed);
  assert.equal(
    await ticketInsteadOfHandoff(scope, ticket, ids, undefined, customer.file),
    ANSWER_HERE
  );
  assert.equal(customer.calls.length, 1);
  const { calls, file } = filer(filed);
  assert.equal(
    await ticketInsteadOfHandoff(
      { ...scope, source: "inbox" },
      ticket,
      ids,
      undefined,
      file
    ),
    null
  );
  assert.equal(calls.length, 0);
  assert.equal(
    await ticketInsteadOfHandoff(scope, ticket, ids, undefined, undefined),
    null
  );
});

test("a ticket that cannot be filed returns no line", async () => {
  const refused = filer({ error: "Linear did not accept the ticket." });
  assert.equal(
    await ticketInsteadOfHandoff(scope, ticket, ids, undefined, refused.file),
    null
  );
  const thrown = (() => Promise.reject(new Error("down"))) as never;
  assert.equal(
    await ticketInsteadOfHandoff(scope, ticket, ids, undefined, thrown),
    null
  );
});
