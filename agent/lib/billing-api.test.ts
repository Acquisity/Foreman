const EXPECTED_ERROR_1 = /billingAccount.id/u;
const EXPECTED_ERROR_2 = /too much data/u;
const EXPECTED_ERROR_3 = /too much data/u;
const EXPECTED_ERROR_4 = /too much data/u;

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { z } from "zod";
import {
  readAutumnCustomer,
  readStripeCharge,
  readStripeCoupon,
  readStripeCustomerBilling,
  readStripeDispute,
  readStripePromotionCode,
  readStripeRefund,
  stripeLookupSchema,
} from "./billing-api.js";
import type {
  OperationRequest,
  ProviderClient,
  ProviderResult,
} from "./executor/operations.js";

const json = (data: unknown, status = 200): Promise<ProviderResult> =>
  Promise.resolve({ data, status });
const AUTUMN_TIMEOUT = /Autumn did not respond within 20 seconds/u;
const STRIPE_TIMEOUT = /Stripe did not respond within 20 seconds/u;
const STRIPE_UNREACHABLE = /Stripe could not be reached/u;

describe("typed billing reads", () => {
  it("preserves Autumn expansions, identifier guidance, and sensitive-field filtering", async () => {
    let request: OperationRequest | undefined;
    const result = await readAutumnCustomer("account/with spaces", {
      client: (r) => {
        request = r;
        return json({
          email: "private",
          id: "account",
          name: "private",
          subscriptions: [{ plan: { id: "pro" } }],
        });
      },
    });
    assert.deepEqual(request, {
      input: {
        body: {
          customer_id: "account/with spaces",
          expand: [
            "subscriptions.plan",
            "purchases.plan",
            "balances.feature",
            "flags.feature",
          ],
        },
        "x-api-version": "2.3.0",
      },
      operation: "autumn.customer",
    });
    assert.deepEqual(result, {
      id: "account",
      subscriptions: [{ plan: { id: "pro" } }],
    });
    await assert.rejects(
      readAutumnCustomer("org_123", {
        client: () => json({ detail: "private" }, 404),
      }),
      EXPECTED_ERROR_1
    );
    await assert.rejects(
      readAutumnCustomer("account", {
        client: () => json({ detail: "private" }, 403),
      }),
      (e) =>
        e instanceof Error &&
        e.message.includes("403") &&
        !e.message.includes("private")
    );
  });
  it("keeps all six bounded customer history reads and distinguishes unavailable from empty", async () => {
    const requests: OperationRequest[] = [];
    const result = await readStripeCustomerBilling("cus_123", {
      client: (request) => {
        requests.push(request);
        return request.operation === "stripe.credit_notes.list"
          ? json({ detail: "private" }, 403)
          : json({ data: [] });
      },
    });
    assert.equal(requests.length, 6);
    assert.deepEqual(
      requests.find((r) => r.operation === "stripe.subscriptions.list"),
      {
        input: { customer: "cus_123", limit: 20, status: "all" },
        operation: "stripe.subscriptions.list",
      }
    );
    assert.ok(result.creditNotes.error?.includes("403"));
    assert.deepEqual(result.charges, { data: { data: [] } });
    assert.ok(
      requests.every((r) => !("limit" in r.input) || r.input.limit === 20)
    );
  });
  it("preserves all billing lookup identifiers without URL encoding round trips", async () => {
    const requests: OperationRequest[] = [];
    const client: ProviderClient = (request) => {
      requests.push(request);
      return json({ id: "known" });
    };
    await readStripeCharge("ch_123", { client });
    await readStripeRefund("re_123", { client });
    await readStripeDispute("du_123", { client });
    await readStripeCoupon("coupon/with & spaces", { client });
    await readStripePromotionCode("Save 20% & more", { client });
    assert.deepEqual(requests, [
      {
        input: { charge_id: "ch_123", "expand[]": "refunds" },
        operation: "stripe.charges.get",
      },
      { input: { refund_id: "re_123" }, operation: "stripe.refunds.get" },
      { input: { dispute_id: "du_123" }, operation: "stripe.disputes.get" },
      {
        input: { coupon_id: "coupon/with & spaces" },
        operation: "stripe.coupons.get",
      },
      {
        input: { code: "Save 20% & more", limit: 20 },
        operation: "stripe.promotion_codes.list",
      },
    ]);
  });
  it("sanitizes nested payment data and enforces input and aggregated output byte caps", async () => {
    const value = await readStripeCharge("ch_123", {
      client: () =>
        json({
          billing_details: { name: "private" },
          id: "ch_123",
          object: "charge",
          refunds: { data: [{ id: "re_123", payment_method: "private" }] },
          source: { number: "private" },
        }),
    });
    assert.deepEqual(value, {
      id: "ch_123",
      object: "charge",
      refunds: { data: [{ id: "re_123" }] },
    });
    await assert.rejects(
      readStripeCharge("ch_123", {
        client: () => json({ description: "x".repeat(300_000) }),
      }),
      EXPECTED_ERROR_2
    );
    await assert.rejects(
      readAutumnCustomer("account", {
        client: () => json({ description: "x".repeat(300_000) }),
      }),
      EXPECTED_ERROR_3
    );
    await assert.rejects(
      readStripeCustomerBilling("cus_123", {
        client: () => json({ description: "x".repeat(50_000) }),
      }),
      EXPECTED_ERROR_4
    );
  });
});
describe("Stripe lookup input", () => {
  it("is a flat object whose lookup names its own id field", () => {
    const schema = z.toJSONSchema(stripeLookupSchema) as { type?: string };
    assert.equal(schema.type, "object");
    assert.equal(
      stripeLookupSchema.safeParse({
        customerId: "cus_V3MWzkrYbpcag8",
        lookup: "customer",
      }).success,
      true
    );
    assert.equal(
      stripeLookupSchema.safeParse({ lookup: "customer" }).success,
      false
    );
    assert.equal(
      stripeLookupSchema.safeParse({
        customerId: "4c05eed7",
        lookup: "customer",
      }).success,
      false
    );
    assert.equal(
      stripeLookupSchema.safeParse({ code: "SAVE20", lookup: "promotion_code" })
        .success,
      true
    );
  });
});

describe("billing read deadlines", () => {
  /** Rejects only when the signal it was handed aborts, with that signal's reason. */
  const signalDrivenFetch =
    (started?: () => void): ProviderClient =>
    (_url, init) =>
      new Promise<ProviderResult>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        started?.();
      });

  /** Runs `body` with the deadline timer under the test's control. */
  const withDeadlineTimer = async (
    body: (expire: () => void) => Promise<void>
  ): Promise<void> => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      await body(() => mock.timers.tick(20_000));
    } finally {
      mock.timers.reset();
    }
  };

  /** Starts a read whose fetch hangs until the composed signal aborts. */
  const startRead = (read: (fetchImpl: ProviderClient) => Promise<unknown>) => {
    let ready: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    return { pending: read(signalDrivenFetch(() => ready())), started };
  };

  const isCancellation = (error: unknown): boolean =>
    error instanceof Error &&
    error.name === "AbortError" &&
    !error.message.includes("did not respond");

  it("composes the deadline with the caller signal on every read", async () => {
    const controller = new AbortController();
    const sent: AbortSignal[] = [];
    const fetchStub: ProviderClient = (_url, init) => {
      sent.push(init?.signal as AbortSignal);
      return json({ id: "x" });
    };
    const options = { client: fetchStub, signal: controller.signal };

    await readAutumnCustomer("org_123", options);
    await readStripeCharge("ch_123", options);
    await readStripeCustomerBilling("cus_123", options);

    assert.equal(sent.length, 8);
    for (const signal of sent) {
      assert.notEqual(signal, controller.signal);
      assert.equal(signal.aborted, false);
    }

    controller.abort();
    for (const signal of sent) {
      assert.equal(signal.aborted, true);
    }
  });

  it("attaches the deadline when the caller passes no signal", async () => {
    let sent: AbortSignal | null | undefined;
    const fetchStub: ProviderClient = (_url, init) => {
      sent = init?.signal;
      return json({ id: "re_123" });
    };

    await readStripeRefund("re_123", { client: fetchStub });

    assert.ok(sent instanceof AbortSignal);
    assert.equal(sent.aborted, false);
  });

  it("maps an expired deadline to the Autumn timeout message", async () => {
    await withDeadlineTimer(async (expire) => {
      const { pending, started } = startRead((fetchImpl) =>
        readAutumnCustomer("org_123", { client: fetchImpl })
      );
      await started;

      expire();

      await assert.rejects(pending, AUTUMN_TIMEOUT);
    });
  });

  it("maps an expired deadline to the Stripe timeout message", async () => {
    await withDeadlineTimer(async (expire) => {
      const { pending, started } = startRead((fetchImpl) =>
        readStripeCharge("ch_123", { client: fetchImpl })
      );
      await started;

      expire();

      await assert.rejects(pending, STRIPE_TIMEOUT);
    });
  });

  it("keeps an expired deadline a timeout when the caller aborts afterwards", async () => {
    await withDeadlineTimer(async (expire) => {
      const controller = new AbortController();
      const { pending, started } = startRead((fetchImpl) =>
        readStripeCharge("ch_123", {
          client: fetchImpl,
          signal: controller.signal,
        })
      );
      await started;

      // The deadline fires first, then the caller aborts before the rejection
      // handler runs. The read still timed out.
      expire();
      controller.abort();

      await assert.rejects(pending, STRIPE_TIMEOUT);
    });
  });

  it("reports a caller abort that beats the deadline as cancellation", async () => {
    await withDeadlineTimer(async (expire) => {
      const controller = new AbortController();
      const { pending, started } = startRead((fetchImpl) =>
        readAutumnCustomer("org_123", {
          client: fetchImpl,
          signal: controller.signal,
        })
      );
      await started;

      controller.abort();
      expire();

      await assert.rejects(pending, isCancellation);
    });
  });

  it("reports an already-aborted caller signal as cancellation", async () => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      readAutumnCustomer("org_123", {
        client: signalDrivenFetch(),
        signal: controller.signal,
      }),
      isCancellation
    );
  });

  it("does not report an unrelated TimeoutError as a deadline expiry", async () => {
    const timeoutNamedFetch: ProviderClient = () =>
      Promise.reject(new DOMException("Upstream timed out.", "TimeoutError"));

    await assert.rejects(
      readStripeCharge("ch_123", {
        client: timeoutNamedFetch,
      }),
      STRIPE_UNREACHABLE
    );
  });
});
