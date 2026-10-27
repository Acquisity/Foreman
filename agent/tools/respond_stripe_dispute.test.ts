import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it, type TestContext } from "node:test";
import type { SessionAuthContext } from "eve/context";
import type { ApprovalContext } from "eve/tools/approval";
import type { ExecutorOutcome } from "#lib/executor/dispatch.js";
import {
  DISPUTE_WRITE_CONNECTION,
  invokeProvider,
} from "#lib/executor/dispatch.js";
import {
  disputeWireArgs,
  type OperationRequest,
} from "#lib/executor/operations.js";
import {
  STRIPE_DISPUTES_CHANNEL,
  stripeDisputeSessionAuth,
} from "#lib/stripe-dispute-trigger.js";
import { stampIntakeOnly, stampQuestionsOnly } from "#lib/trust.js";
import {
  type DisputeDeps,
  type EvidenceFile,
  evidenceFingerprint,
  type RespondInput,
  renderEvidencePdf,
  respondStripeDispute,
  respondStripeDisputePolicy,
  valueHash,
} from "./respond_stripe_dispute.js";

/** Stripe routes no code path may reach: accepting a dispute, file links, refunds. */
const FORBIDDEN_ROUTES = ["close", "file_links", "v1/refunds"].map(
  (route) => `/${route}`
);

/** Whether a refusal reason contains any of the "|"-separated phrases. */
const reasonMatches = (reason: string | undefined, phrases: string) =>
  phrases.split("|").some((phrase) => (reason ?? "").includes(phrase));

const NOW = Date.parse("2026-10-26T12:00:00Z");
const DUE = NOW / 1000 + 3 * 86_400;
const ID = "du_1AbCdEf";

const person = (channelId = STRIPE_DISPUTES_CHANNEL): SessionAuthContext => ({
  attributes: {
    author_type: "user",
    channel_id: channelId,
    stripeDisputeApproved: "true",
    stripeDisputeId: ID,
    team_id: "T123",
    thread_ts: "1761400000.000100",
    trusted: "true",
    user_id: "U123",
  },
  authenticator: "slack-webhook",
  issuer: "slack:T123",
  principalId: "slack:T123:U123",
  principalType: "user",
});
const automatic = stripeDisputeSessionAuth({
  disputeId: ID,
  teamId: "T123",
  threadTs: "1761400000.000100",
});

const disputeRecord = (overrides: Record<string, unknown> = {}) => ({
  amount: 18_500,
  charge: "ch_1",
  currency: "usd",
  evidence: {
    customer_email_address: "owner@example.com",
    customer_name: "Eric Mead",
    product_description: "Acquisity subscription",
    uncategorized_text: null,
  },
  evidence_details: {
    due_by: DUE,
    has_evidence: true,
    past_due: false,
    submission_count: 0,
  },
  id: ID,
  metadata: {},
  object: "dispute",
  payment_method_details: {
    card: { brand: "visa", network_reason_code: "10.4" },
    type: "card",
  },
  reason: "fraudulent",
  status: "needs_response",
  ...overrides,
});

/** A fake Stripe: reads return the dispute, writes update it. */
const fakeStripe = (
  initial: Record<string, unknown> = disputeRecord(),
  options: { upload?: () => ExecutorOutcome } = {}
) => {
  let dispute = structuredClone(initial) as ReturnType<typeof disputeRecord>;
  const writes: {
    input: Record<string, unknown>;
    operation: string;
  }[] = [];
  const reads: OperationRequest[] = [];
  let files = 0;
  const deps = (
    auth: SessionAuthContext | null,
    delegated = false
  ): DisputeDeps => ({
    auth: { current: auth, initiator: auth },
    delegated,
    now: () => NOW,
    read: (request) => {
      reads.push(request);
      if (request.operation === "stripe.disputes.get") {
        return Promise.resolve({ data: structuredClone(dispute), status: 200 });
      }
      if (request.operation === "stripe.charges.get") {
        return Promise.resolve({
          data: {
            amount: 18_500,
            amount_refunded: 18_500,
            billing_details: {
              email: "cardholder@example.com",
              name: "Eric Mead",
            },
            created: 1_759_536_000,
            customer: "cus_1",
            refunds: {
              data: [{ amount: 18_500, created: 1_760_000_000, id: "re_1" }],
            },
          },
          status: 200,
        });
      }
      return Promise.resolve({
        data: {
          email: "owner@example.com",
          metadata: { autumn_id: "0b6c6f4e-3c1a-4d8e-9a77-2f1e5d4c3b2a" },
          name: "Owner",
        },
        status: 200,
      });
    },
    write: (operation, input) => {
      writes.push({ input, operation });
      if (operation === "stripe.files.create") {
        if (options.upload) {
          return Promise.resolve(options.upload());
        }
        files += 1;
        return Promise.resolve({ data: { id: `file_${files}` }, ok: true });
      }
      if (input.submit === true) {
        dispute = {
          ...dispute,
          evidence_details: {
            ...dispute.evidence_details,
            submission_count: 1,
          },
          status: "under_review",
        };
      } else {
        dispute = {
          ...dispute,
          evidence: { ...dispute.evidence, ...(input.evidence as object) },
          metadata: input.metadata as Record<string, never>,
        };
      }
      return Promise.resolve({ data: structuredClone(dispute), ok: true });
    },
  });
  /** A person or Acquisity editing evidence in Stripe. */
  const edit = (evidence: Record<string, unknown>) => {
    dispute = { ...dispute, evidence: { ...dispute.evidence, ...evidence } };
  };
  return { deps, edit, reads, writes };
};

const run = (deps: DisputeDeps, input: Partial<RespondInput>) =>
  respondStripeDispute({ action: "check", disputeId: ID, ...input }, deps);

const file = (
  slot: EvidenceFile["slot"],
  lines = 5,
  sections = 1
): EvidenceFile => ({
  sections: Array.from({ length: sections }, (_unused, part) => ({
    heading: `Client channel thread ${part + 1}`,
    lines: Array.from(
      { length: lines },
      (_, index) => `2026-09-0${(index % 9) + 1} 10:00 Eric Mead: line ${index}`
    ),
  })),
  slot,
  title: "Customer communication",
});

describe("respond_stripe_dispute rule 3", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    [
      "already submitted",
      { evidence_details: { due_by: DUE, submission_count: 1 } },
      "already submitted",
    ],
    ["won", { status: "won" }, "is won"],
    ["under review", { status: "under_review" }, "is under_review"],
    [
      "past due",
      { evidence_details: { due_by: NOW / 1000 - 60, submission_count: 0 } },
      "deadline",
    ],
  ];
  cases.push(
    [
      "Stripe omits the submission count",
      { evidence_details: undefined },
      "did not report",
    ],
    [
      "Stripe omits the deadline",
      { evidence_details: { due_by: null, submission_count: 0 } },
      "did not report",
    ]
  );
  for (const [name, overrides, reason] of cases) {
    it(`refuses to stage or submit when ${name}, with no write`, async () => {
      const stripe = fakeStripe(disputeRecord(overrides));
      const staged = await run(stripe.deps(automatic), {
        action: "stage",
        evidence: { access_activity_log: "Logged in 40 times." },
      });
      assert.equal(staged.ok, false);
      assert.ok(reasonMatches(staged.reason, reason), staged.reason);
      const submitted = await run(stripe.deps(person()), {
        action: "submit",
        fingerprint: "x",
      });
      assert.equal(submitted.ok, false);
      assert.ok(reasonMatches(submitted.reason, reason), submitted.reason);
      assert.deepEqual(stripe.writes, []);
    });
  }

  it("refuses an id that is not a dispute id before any call", async () => {
    const stripe = fakeStripe();
    const result = await run(stripe.deps(person()), { disputeId: "ch_1" });
    assert.equal(result.ok, false);
    assert.deepEqual(stripe.reads, []);
  });

  it("check reports the refusal line, the reason code, and both identities", async () => {
    const stripe = fakeStripe(disputeRecord({ status: "lost" }));
    const result = await run(stripe.deps(automatic), {});
    const facts = result.result as Record<string, unknown>;
    assert.equal(result.ok, true);
    assert.ok(reasonMatches(String(facts.refusal), "is lost"));
    assert.equal(facts.networkReasonCode, "10.4");
    assert.deepEqual(facts.identity, {
      cardholder: { email: "cardholder@example.com", name: "Eric Mead" },
      charge: {
        amount: 18_500,
        amountRefunded: 18_500,
        created: "2025-10-04T00:00:00.000Z",
        id: "ch_1",
        invoice: null,
        paymentIntent: null,
        refunds: [
          {
            amount: 18_500,
            created: "2025-10-09T08:53:20.000Z",
            id: "re_1",
            status: null,
          },
        ],
      },
      customer: {
        autumnId: "0b6c6f4e-3c1a-4d8e-9a77-2f1e5d4c3b2a",
        email: "owner@example.com",
        id: "cus_1",
        name: "Owner",
      },
    });
  });
});

describe("respond_stripe_dispute stage", () => {
  it("always stages with submit=false and keeps Acquisity's fields", async () => {
    const stripe = fakeStripe();
    const result = await run(stripe.deps(automatic), {
      action: "stage",
      evidence: { access_activity_log: "40 logins since signup." },
      files: [file("customer_communication")],
    });
    assert.equal(result.ok, true, result.reason);
    const update = stripe.writes.find(
      (w) => w.operation === "stripe.disputes.update"
    );
    assert.equal(update?.input.submit, false);
    assert.deepEqual(update?.input.evidence, {
      access_activity_log: "40 logins since signup.",
      customer_communication: "file_1",
    });
    const staged = result.result as {
      evidence: Record<string, string>;
      fingerprint: string;
    };
    assert.equal(staged.evidence.customer_name, "Eric Mead");
    assert.equal(staged.fingerprint, evidenceFingerprint(staged.evidence));
  });

  it("refuses to replace a field Acquisity staged, but lets Foreman restage its own", async () => {
    const stripe = fakeStripe();
    const taken = await run(stripe.deps(automatic), {
      action: "stage",
      evidence: { product_description: "Something else" },
    });
    assert.equal(taken.ok, false);
    assert.ok(reasonMatches(taken.reason, "product_description"), taken.reason);
    assert.deepEqual(stripe.writes, []);
    await run(stripe.deps(automatic), {
      action: "stage",
      evidence: { uncategorized_text: "First pass." },
    });
    const again = await run(stripe.deps(person()), {
      action: "stage",
      evidence: { uncategorized_text: "Second pass, as the person asked." },
    });
    assert.equal(again.ok, true, again.reason);
  });

  it("refuses to replace a field a person corrected after Foreman staged it", async () => {
    const stripe = fakeStripe();
    await run(stripe.deps(automatic), {
      action: "stage",
      evidence: { uncategorized_text: "First pass." },
    });
    stripe.edit({ uncategorized_text: "Corrected by a person." });
    const writes = stripe.writes.length;
    const result = await run(stripe.deps(person()), {
      action: "stage",
      evidence: { uncategorized_text: "Second pass." },
    });
    assert.equal(result.ok, false);
    assert.ok(
      reasonMatches(result.reason, "uncategorized_text"),
      result.reason
    );
    assert.equal(stripe.writes.length, writes);
  });

  it("records a hash of each value it wrote", async () => {
    const stripe = fakeStripe();
    await run(stripe.deps(automatic), {
      action: "stage",
      evidence: { uncategorized_text: "First pass." },
    });
    const update = stripe.writes.at(-1)?.input.metadata as Record<
      string,
      string
    >;
    assert.deepEqual(JSON.parse(String(update.foreman_fields)), {
      uncategorized_text: valueHash("First pass."),
    });
  });

  it("refuses new files when the dispute already holds files, but still stages text", async () => {
    const stripe = fakeStripe(
      disputeRecord({
        evidence: { ...disputeRecord().evidence, receipt: "file_acq" },
      })
    );
    const withFiles = await run(stripe.deps(automatic), {
      action: "stage",
      evidence: { access_activity_log: "40 logins." },
      files: [file("service_documentation")],
    });
    assert.equal(withFiles.ok, false);
    assert.ok(reasonMatches(withFiles.reason, "receipt"), withFiles.reason);
    assert.deepEqual(stripe.writes, []);
    const textOnly = await run(stripe.deps(automatic), {
      action: "stage",
      evidence: { access_activity_log: "40 logins." },
    });
    assert.equal(textOnly.ok, true, textOnly.reason);
  });

  it("refuses when the deadline passes while files render", async () => {
    const stripe = fakeStripe(
      disputeRecord({
        evidence_details: { due_by: NOW / 1000 + 5, submission_count: 0 },
      })
    );
    let now = NOW;
    const deps = {
      ...stripe.deps(automatic),
      now: () => now,
      render: async (input: EvidenceFile) => {
        now += 60_000;
        return await renderEvidencePdf(input);
      },
    };
    const result = await run(deps, {
      action: "stage",
      files: [file("customer_communication")],
    });
    assert.equal(result.ok, false);
    assert.ok(reasonMatches(result.reason, "deadline"), result.reason);
    assert.deepEqual(stripe.writes, []);
  });

  it("re-reads after uploads and refuses when a field was filled meanwhile", async () => {
    const stripe = fakeStripe();
    const deps = {
      ...stripe.deps(automatic),
      write: (...args: Parameters<ReturnType<typeof stripe.deps>["write"]>) => {
        stripe.edit({ uncategorized_text: "Staged by Acquisity meanwhile." });
        return stripe.deps(automatic).write(...args);
      },
    };
    const result = await run(deps, {
      action: "stage",
      evidence: { uncategorized_text: "Foreman's text." },
      files: [file("customer_communication")],
    });
    assert.equal(result.ok, false);
    assert.ok(
      reasonMatches(result.reason, "uncategorized_text"),
      result.reason
    );
    assert.ok(
      stripe.writes.every((w) => w.operation === "stripe.files.create")
    );
  });

  it("refuses links in evidence", async () => {
    const stripe = fakeStripe();
    const result = await run(stripe.deps(automatic), {
      action: "stage",
      evidence: { uncategorized_text: "See https://example.com/terms" },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(stripe.writes, []);
  });

  it("measures a rendered PDF's pages and bytes", async () => {
    const small = await renderEvidencePdf(file("receipt", 3));
    assert.equal(small.pages, 1);
    assert.equal(new TextDecoder().decode(small.bytes.slice(0, 5)), "%PDF-");
    const long = await renderEvidencePdf(file("receipt", 200));
    assert.ok(long.pages > 1);
    assert.ok(long.bytes.length > small.bytes.length);
  });

  it("keeps line breaks inside one section line", async () => {
    const lines = Array.from({ length: 120 }, (_, i) => `Message ${i}`);
    const render = (text: string) =>
      renderEvidencePdf({
        sections: [{ heading: "Thread", lines: [text] }],
        slot: "customer_communication",
        title: "Client channel",
      });
    assert.equal((await render(lines.join(" "))).pages, 1);
    assert.ok((await render(lines.join("\n"))).pages > 1);
  });

  it("refuses over the page limit before any upload, tighter for Mastercard", async () => {
    const visa = fakeStripe();
    const tooLong = await run(visa.deps(automatic), {
      action: "stage",
      files: [file("customer_communication", 1000, 4)],
    });
    assert.equal(tooLong.ok, false);
    assert.ok(reasonMatches(tooLong.reason, "pages"), tooLong.reason);
    assert.deepEqual(visa.writes, []);

    const mastercard = fakeStripe(
      disputeRecord({
        payment_method_details: {
          card: { brand: "mastercard", network_reason_code: "4837" },
        },
      })
    );
    const pages = await renderEvidencePdf(file("customer_communication", 1200));
    assert.ok(pages.pages > 19 && pages.pages <= 49, String(pages.pages));
    const result = await run(mastercard.deps(automatic), {
      action: "stage",
      files: [file("customer_communication", 1200)],
    });
    assert.equal(result.ok, false);
    assert.ok(reasonMatches(result.reason, "allows 19"), result.reason);
    assert.deepEqual(mastercard.writes, []);
  });

  it("refuses over 4.5 MB before any upload", async () => {
    const stripe = fakeStripe();
    const deps = {
      ...stripe.deps(automatic),
      render: () =>
        Promise.resolve({ bytes: new Uint8Array(4_600_000), pages: 1 }),
    };
    const result = await run(deps, {
      action: "stage",
      files: [file("receipt")],
    });
    assert.equal(result.ok, false);
    assert.ok(reasonMatches(result.reason, "bytes"), result.reason);
    assert.deepEqual(stripe.writes, []);
  });

  it("stages nothing when any upload fails, and says how to continue", async () => {
    let uploads = 0;
    const stripe = fakeStripe(disputeRecord(), {
      upload: () => {
        uploads += 1;
        return uploads === 1
          ? { data: { id: "file_1" }, ok: true }
          : { error: { code: "http_error", status: 500 }, ok: false };
      },
    });
    const result = await run(stripe.deps(automatic), {
      action: "stage",
      evidence: { access_activity_log: "40 logins." },
      files: [file("customer_communication"), file("receipt")],
    });
    assert.equal(result.ok, false);
    assert.ok(
      reasonMatches(result.reason, "nothing was staged"),
      result.reason
    );
    assert.ok(
      stripe.writes.every((w) => w.operation === "stripe.files.create")
    );
  });
});

describe("respond_stripe_dispute submit", () => {
  const staged = async () => {
    const stripe = fakeStripe();
    const result = await run(stripe.deps(automatic), {
      action: "stage",
      evidence: { access_activity_log: "40 logins." },
    });
    const { fingerprint } = result.result as { fingerprint: string };
    return { fingerprint, stripe };
  };

  it("is denied in the automatic dispute session, with no write", async () => {
    const { fingerprint, stripe } = await staged();
    const writes = stripe.writes.length;
    const result = await run(stripe.deps(automatic), {
      action: "submit",
      fingerprint,
    });
    assert.equal(result.ok, false);
    assert.ok(
      reasonMatches(result.reason, "person approves every submit"),
      result.reason
    );
    assert.equal(stripe.writes.length, writes);
  });

  it("is allowed for a person in the disputes channel and sends no evidence", async () => {
    const { fingerprint, stripe } = await staged();
    const result = await run(stripe.deps(person()), {
      action: "submit",
      fingerprint,
    });
    assert.equal(result.ok, true, result.reason);
    const submit = stripe.writes.at(-1);
    assert.deepEqual(submit?.input, {
      dispute_id: ID,
      "Idempotency-Key": `foreman-dispute-submit-${ID}-${fingerprint}`,
      submit: true,
    });
  });

  it("refuses an approval from a thread whose alert names another dispute, or none", async () => {
    const { fingerprint, stripe } = await staged();
    const writes = stripe.writes.length;
    const { stripeDisputeId: _ignored, ...unbound } = person().attributes;
    const elsewhere = { ...person(), attributes: unbound };
    const result = await run(stripe.deps(elsewhere), {
      action: "submit",
      fingerprint,
    });
    assert.equal(result.ok, false);
    assert.ok(reasonMatches(result.reason, "alert thread"), result.reason);
    assert.equal(stripe.writes.length, writes);
  });

  it("sends the same idempotency key for the same approval and a new one for new evidence", async () => {
    const submitKey = async (log: string) => {
      const stripe = fakeStripe();
      const result = await run(stripe.deps(automatic), {
        action: "stage",
        evidence: { access_activity_log: log },
      });
      const { fingerprint } = result.result as { fingerprint: string };
      await run(stripe.deps(person()), { action: "submit", fingerprint });
      return stripe.writes.at(-1)?.input["Idempotency-Key"];
    };
    const first = await submitKey("40 logins.");
    assert.ok(typeof first === "string" && first.includes(ID));
    assert.equal(await submitKey("40 logins."), first);
    assert.notEqual(await submitKey("41 logins."), first);
  });

  it("refuses a person's turn that is not a go-ahead, with no write", async () => {
    const { fingerprint, stripe } = await staged();
    const writes = stripe.writes.length;
    const { stripeDisputeApproved: _approved, ...asked } = person().attributes;
    const result = await run(stripe.deps({ ...person(), attributes: asked }), {
      action: "submit",
      fingerprint,
    });
    assert.equal(result.ok, false);
    assert.ok(reasonMatches(result.reason, "say approve"), result.reason);
    assert.equal(stripe.writes.length, writes);
  });

  it("refuses when the evidence changed after the ready message", async () => {
    const { stripe } = await staged();
    const writes = stripe.writes.length;
    const result = await run(stripe.deps(person()), {
      action: "submit",
      fingerprint: "0000000000000000",
    });
    assert.equal(result.ok, false);
    assert.ok(reasonMatches(result.reason, "evidence changed"), result.reason);
    assert.equal(stripe.writes.length, writes);
  });

  it("re-checks Stripe first, so a retried submit does not submit twice", async () => {
    const { fingerprint, stripe } = await staged();
    const first = await run(stripe.deps(person()), {
      action: "submit",
      fingerprint,
    });
    assert.equal(first.ok, true);
    const writes = stripe.writes.length;
    const retry = await run(stripe.deps(person()), {
      action: "submit",
      fingerprint,
    });
    assert.equal(retry.ok, false);
    assert.ok(
      reasonMatches(retry.reason, "already submitted|under_review"),
      retry.reason
    );
    assert.equal(stripe.writes.length, writes);
  });

  it("is denied for a person in another channel, a delegated task, and a bot", async () => {
    const { fingerprint, stripe } = await staged();
    const bot = {
      ...person(),
      attributes: { ...person().attributes, author_type: "bot" },
    };
    const results = await Promise.all(
      [
        stripe.deps(person("C0DEV")),
        stripe.deps(person(), true),
        stripe.deps(bot),
      ].map((deps) => run(deps, { action: "submit", fingerprint }))
    );
    assert.ok(results.every((result) => !result.ok));
  });
});

describe("respond_stripe_dispute approval policy", () => {
  const policy = (
    current: SessionAuthContext | null,
    action: string,
    initiator: SessionAuthContext | null = current
  ) =>
    respondStripeDisputePolicy({
      session: { auth: { current, initiator } },
      toolInput: { action },
    } as unknown as ApprovalContext);

  it("denies, never parks, intake-only and questions-only sessions", () => {
    for (const auth of [
      stampIntakeOnly(person()),
      stampQuestionsOnly(person()),
    ]) {
      for (const action of ["check", "stage", "submit"]) {
        const status = policy(auth, action);
        assert.equal(typeof status, "object", action);
        assert.equal((status as { type: string }).type, "denied");
      }
    }
  });

  it("lets the automatic session check and stage but not submit", () => {
    assert.equal(policy(automatic, "check"), "not-applicable");
    assert.equal(policy(automatic, "stage"), "not-applicable");
    assert.equal(
      (policy(automatic, "submit") as { type: string }).type,
      "denied"
    );
  });

  it("lets a person in the channel submit, even in a thread the automatic session started", () => {
    assert.equal(policy(person(), "submit", automatic), "not-applicable");
  });

  it("denies every other session", () => {
    for (const action of ["check", "stage", "submit"]) {
      assert.equal(
        (policy(person("C0DEV"), action) as { type: string }).type,
        "denied"
      );
      assert.equal((policy(null, action) as { type: string }).type, "denied");
    }
  });
});

describe("respond_stripe_dispute write surface", () => {
  it("has no close, file link, or refund path in code or the bound spec", () => {
    const sources = [
      "./respond_stripe_dispute.ts",
      "../../.github/executor/specs/stripe-dispute-write.json",
      "../../.github/executor/disputes-toolkit-manifest.json",
    ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
    for (const source of sources) {
      for (const route of FORBIDDEN_ROUTES) {
        assert.ok(!source.includes(route), route);
      }
    }
    const spec = JSON.parse(sources[1] ?? "{}") as {
      paths: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(spec.paths).sort(), [
      "/v1/disputes/{dispute_id}",
      "/v1/files",
    ]);
  });
});

describe("dispute write dispatch", () => {
  // The shapes Executor accepted for both operations against the Stripe sandbox
  // (ENG-16255): request fields under body, the PDF as a ToolFile.
  it("sends Executor its body and ToolFile argument shapes", () => {
    assert.deepEqual(
      disputeWireArgs("stripe.disputes.update", {
        dispute_id: ID,
        evidence: { uncategorized_text: "Signed in daily." },
        "Idempotency-Key": "foreman-dispute-stage-abc",
        submit: false,
      }),
      {
        body: {
          evidence: { uncategorized_text: "Signed in daily." },
          submit: false,
        },
        dispute_id: ID,
        "Idempotency-Key": "foreman-dispute-stage-abc",
      }
    );
    const pdf = Buffer.from("%PDF-1.7 proof").toString("base64");
    assert.deepEqual(
      disputeWireArgs("stripe.files.create", {
        file: pdf,
        purpose: "dispute_evidence",
      }),
      {
        body: {
          file: {
            _tag: "ToolFile",
            byteLength: 14,
            data: pdf,
            encoding: "base64",
            mimeType: "application/pdf",
            name: "evidence.pdf",
          },
          purpose: "dispute_evidence",
        },
      }
    );
    assert.throws(() =>
      disputeWireArgs("stripe.disputes.update", { close: true, dispute_id: ID })
    );
  });

  it("runs in the foreman-disputes toolkit and carries the idempotency key", async (t: TestContext) => {
    const bodies: { url: string; request: Record<string, unknown> }[] = [];
    t.mock.method(globalThis, "fetch", (url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      if (request.method === "notifications/initialized") {
        return Promise.resolve(new Response(null, { status: 202 }));
      }
      if (request.method === "initialize") {
        return Promise.resolve(
          Response.json({
            id: request.id,
            jsonrpc: "2.0",
            result: { protocolVersion: "2025-06-18" },
          })
        );
      }
      bodies.push({ request, url: String(url) });
      return Promise.resolve(
        Response.json({
          id: request.id,
          jsonrpc: "2.0",
          result: {
            structuredContent: {
              result: { data: { id: ID, status: "under_review" }, ok: true },
              status: "completed",
            },
          },
        })
      );
    });
    const ctx = {
      abortSignal: new AbortController().signal,
      getToken: () => Promise.resolve({ token: "synthetic-executor-token" }),
    };
    const path = `${DISPUTE_WRITE_CONNECTION}org.workspaceForemanStripeDisputeWrite.disputes.updateDisputeEvidence`;
    const input = {
      dispute_id: ID,
      "Idempotency-Key": `foreman-dispute-submit-${ID}-abc`,
      submit: true,
    };
    await invokeProvider(ctx as never, path, input);
    assert.equal(bodies.length, 1);
    assert.ok(bodies[0]?.url.includes("/mcp/toolkits/foreman-disputes"));
    assert.ok(
      JSON.stringify(bodies[0]?.request).includes(input["Idempotency-Key"])
    );
  });
});
