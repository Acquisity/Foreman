import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BillingApiError,
  readAutumnCustomer,
  readStripeCharge,
  readStripeCustomerBilling,
  readStripeDispute,
  readStripePromotionCode,
  readStripeRefund,
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
