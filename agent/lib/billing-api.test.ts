import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { z } from "zod";
import {
  BillingApiError,
  readAutumnCustomer,
  readStripeCharge,
  readStripeCustomerBilling,
  readStripeDispute,
  readStripePromotionCode,
  readStripeRefund,
  stripeLookupSchema,
} from "./billing-api.js";

const json = (body: unknown, status = 200): Promise<Response> =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
      status,
    })
  );

const AUTUMN_TOO_MUCH_DATA = /Autumn returned too much data/u;
const STRIPE_TOO_MUCH_DATA = /Stripe returned too much data/u;
const AUTUMN_TIMEOUT = /^Error: Autumn did not respond within 20 seconds\.$/u;
const STRIPE_TIMEOUT = /^Error: Stripe did not respond within 20 seconds\.$/u;
const STRIPE_UNREACHABLE = /^Error: Stripe could not be reached\.$/u;
const AUTUMN_WRONG_ID =
  /Autumn has no customer with id org_123 .*billingAccount\.id/u;

describe("Autumn billing API", () => {
  it("uses the fixed read endpoint and expands billing evidence", async () => {
    let calledUrl = "";
    let calledInit: RequestInit | undefined;
    const fetchStub: typeof fetch = (url, init) => {
      calledUrl = String(url);
      calledInit = init;
      return json({
        email: "customer@example.com",
        id: "org_123",
        name: "Customer Name",
        payment_method: { card: { last4: "4242" } },
        subscriptions: [{ plan: { name: "Inbox add-on" } }],
      });
    };

    const result = await readAutumnCustomer("secret-key", "org_123", {
      fetch: fetchStub,
    });

    assert.deepEqual(result, {
      id: "org_123",
      subscriptions: [{ plan: { name: "Inbox add-on" } }],
    });
    assert.equal(calledUrl, "https://api.useautumn.com/v1/customers.get");
    assert.equal(calledInit?.method, "POST");
    assert.equal(
      new Headers(calledInit?.headers).get("Authorization"),
      "Bearer secret-key"
    );
    assert.equal(
      new Headers(calledInit?.headers).get("x-api-version"),
      "2.3.0"
    );
    assert.deepEqual(JSON.parse(String(calledInit?.body)), {
      customer_id: "org_123",
      expand: [
        "subscriptions.plan",
        "purchases.plan",
        "balances.feature",
        "flags.feature",
      ],
    });
  });

  it("does not expose a provider error body", async () => {
    const fetchStub: typeof fetch = () =>
      Promise.resolve(new Response("secret provider detail", { status: 403 }));

    await assert.rejects(
      readAutumnCustomer("secret-key", "org_123", { fetch: fetchStub }),
      (error) => {
        assert.ok(error instanceof BillingApiError);
        assert.equal(error.status, 403);
        assert.equal(error.message.includes("secret provider detail"), false);
        return true;
      }
    );
  });
});

describe("Autumn billing API 404", () => {
  it("names a wrong customer id instead of an unavailable provider", async () => {
    const fetchStub: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ code: "customer_not_found" }), {
          status: 404,
        })
      );

    await assert.rejects(
      readAutumnCustomer("secret-key", "org_123", { fetch: fetchStub }),
      AUTUMN_WRONG_ID
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

describe("Stripe billing API", () => {
  it("reads only fixed, bounded customer resources", async () => {
    const calls: Array<{ init?: RequestInit; url: string }> = [];
    const fetchStub: typeof fetch = (url, init) => {
      calls.push({ init, url: String(url) });
      return json({
        data: [
          {
            metadata: { source: "campaign" },
            object: "charge",
            source: { address_line1: "123 Main", last4: "4242" },
          },
        ],
        email: "customer@example.com",
        name: String(url).endsWith("/customers/cus_123")
          ? "Customer Name"
          : undefined,
        nested: {
          customer_email_address: "dispute@example.com",
          payment_method_details: { card: { last4: "4242" } },
          receipt_url: "https://pay.example/receipt",
        },
        object: "list",
      });
    };

    const result = await readStripeCustomerBilling(
      "restricted-key",
      "cus_123",
      { fetch: fetchStub }
    );

    assert.equal(Object.keys(result).length, 6);
    assert.deepEqual(
      calls.map(({ url }) => url).sort((a, b) => a.localeCompare(b)),
      [
        "https://api.stripe.com/v1/charges?customer=cus_123&limit=20",
        "https://api.stripe.com/v1/credit_notes?customer=cus_123&limit=20",
        "https://api.stripe.com/v1/customers/cus_123",
        "https://api.stripe.com/v1/customers/cus_123/balance_transactions?limit=20",
        "https://api.stripe.com/v1/invoices?customer=cus_123&limit=20",
        "https://api.stripe.com/v1/subscriptions?customer=cus_123&status=all&limit=20",
      ].sort((a, b) => a.localeCompare(b))
    );
    for (const { init } of calls) {
      assert.equal(init?.method, "GET");
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer restricted-key"
      );
    }
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("customer@example.com"), false);
    assert.equal(serialized.includes("dispute@example.com"), false);
    assert.equal(serialized.includes("Customer Name"), false);
    assert.equal(serialized.includes("payment_method_details"), false);
    assert.equal(serialized.includes("receipt_url"), false);
    assert.equal(serialized.includes("address_line1"), false);
    assert.equal(serialized.includes('"source":"campaign"'), true);
  });

  it("keeps an unauthorized section from hiding the other evidence", async () => {
    const fetchStub: typeof fetch = (url) =>
      String(url).includes("credit_notes")
        ? json({ error: "permission denied" }, 403)
        : json({ data: [] });

    const result = await readStripeCustomerBilling(
      "restricted-key",
      "cus_123",
      { fetch: fetchStub }
    );

    assert.equal(result.creditNotes.error, "Stripe read failed with HTTP 403.");
    assert.deepEqual(result.charges.data, { data: [] });
  });

  it("encodes a promotion code instead of accepting an arbitrary path", async () => {
    let calledUrl = "";
    const fetchStub: typeof fetch = (url) => {
      calledUrl = String(url);
      return json({ data: [] });
    };

    await readStripePromotionCode("restricted-key", "SAVE & WIN", {
      fetch: fetchStub,
    });

    assert.equal(
      calledUrl,
      "https://api.stripe.com/v1/promotion_codes?code=SAVE%20%26%20WIN&limit=20"
    );
  });

  it("reads only known charge, refund, and dispute objects", async () => {
    const calls: string[] = [];
    const fetchStub: typeof fetch = (url) => {
      calls.push(String(url));
      return json({ id: "known" });
    };

    await readStripeCharge("restricted-key", "ch_123", {
      fetch: fetchStub,
    });
    await readStripeRefund("restricted-key", "re_123", {
      fetch: fetchStub,
    });
    await readStripeDispute("restricted-key", "du_123", {
      fetch: fetchStub,
    });

    assert.deepEqual(calls, [
      "https://api.stripe.com/v1/charges/ch_123?expand[]=refunds",
      "https://api.stripe.com/v1/refunds/re_123",
      "https://api.stripe.com/v1/disputes/du_123",
    ]);
  });

  it("propagates cancellation instead of returning partial evidence", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchStub: typeof fetch = () =>
      Promise.reject(new DOMException("Canceled", "AbortError"));

    await assert.rejects(
      readStripeCustomerBilling("restricted-key", "cus_123", {
        fetch: fetchStub,
        signal: controller.signal,
      }),
      (error) => error instanceof Error && error.name === "AbortError"
    );
  });

  it("rejects a customer bundle that exceeds the aggregate output budget", async () => {
    const fetchStub: typeof fetch = () =>
      json({ data: [{ description: "x".repeat(50 * 1024) }] });

    await assert.rejects(
      readStripeCustomerBilling("restricted-key", "cus_123", {
        fetch: fetchStub,
      }),
      STRIPE_TOO_MUCH_DATA
    );
  });
});

describe("billing response bounds", () => {
  const oversized = { data: "x".repeat(256 * 1024 + 1) };

  it("rejects an oversized Autumn response while streaming", async () => {
    await assert.rejects(
      readAutumnCustomer("secret-key", "org_123", {
        fetch: () => json(oversized),
      }),
      AUTUMN_TOO_MUCH_DATA
    );
  });

  it("rejects an oversized Stripe response while streaming", async () => {
    await assert.rejects(
      readStripePromotionCode("restricted-key", "SAVE", {
        fetch: () => json(oversized),
      }),
      STRIPE_TOO_MUCH_DATA
    );
  });
});

describe("billing read deadlines", () => {
  /** Rejects only when the signal it was handed aborts, with that signal's reason. */
  const signalDrivenFetch =
    (started?: () => void): typeof fetch =>
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
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
  const startRead = (read: (fetchImpl: typeof fetch) => Promise<unknown>) => {
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
    const fetchStub: typeof fetch = (_url, init) => {
      sent.push(init?.signal as AbortSignal);
      return json({ id: "x" });
    };
    const options = { fetch: fetchStub, signal: controller.signal };

    await readAutumnCustomer("secret-key", "org_123", options);
    await readStripeCharge("restricted-key", "ch_123", options);
    await readStripeCustomerBilling("restricted-key", "cus_123", options);

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
    const fetchStub: typeof fetch = (_url, init) => {
      sent = init?.signal;
      return json({ id: "re_123" });
    };

    await readStripeRefund("restricted-key", "re_123", { fetch: fetchStub });

    assert.ok(sent instanceof AbortSignal);
    assert.equal(sent.aborted, false);
  });

  it("maps an expired deadline to the Autumn timeout message", async () => {
    await withDeadlineTimer(async (expire) => {
      const { pending, started } = startRead((fetchImpl) =>
        readAutumnCustomer("secret-key", "org_123", { fetch: fetchImpl })
      );
      await started;

      expire();

      await assert.rejects(pending, AUTUMN_TIMEOUT);
    });
  });

  it("maps an expired deadline to the Stripe timeout message", async () => {
    await withDeadlineTimer(async (expire) => {
      const { pending, started } = startRead((fetchImpl) =>
        readStripeCharge("restricted-key", "ch_123", { fetch: fetchImpl })
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
        readStripeCharge("restricted-key", "ch_123", {
          fetch: fetchImpl,
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
        readAutumnCustomer("secret-key", "org_123", {
          fetch: fetchImpl,
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
      readAutumnCustomer("secret-key", "org_123", {
        fetch: signalDrivenFetch(),
        signal: controller.signal,
      }),
      isCancellation
    );
  });

  it("does not report an unrelated TimeoutError as a deadline expiry", async () => {
    const timeoutNamedFetch: typeof fetch = () =>
      Promise.reject(new DOMException("Upstream timed out.", "TimeoutError"));

    await assert.rejects(
      readStripeCharge("restricted-key", "ch_123", {
        fetch: timeoutNamedFetch,
      }),
      STRIPE_UNREACHABLE
    );
  });
});
