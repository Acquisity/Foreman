import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BillingApiError,
  readAutumnCustomer,
  readStripeCustomerBilling,
  readStripePromotionCode,
} from "./billing-api.js";

const json = (body: unknown, status = 200): Promise<Response> =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
      status,
    })
  );

describe("Autumn billing API", () => {
  it("uses the fixed read endpoint and expands billing evidence", async () => {
    let calledUrl = "";
    let calledInit: RequestInit | undefined;
    const fetchStub: typeof fetch = (url, init) => {
      calledUrl = String(url);
      calledInit = init;
      return json({
        id: "org_123",
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

describe("Stripe billing API", () => {
  it("reads only fixed, bounded customer resources", async () => {
    const calls: Array<{ init?: RequestInit; url: string }> = [];
    const fetchStub: typeof fetch = (url, init) => {
      calls.push({ init, url: String(url) });
      return json({ object: "list" });
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
});
