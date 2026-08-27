import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  billingAccountQueries,
  HISTORY_LIMIT,
  organizationIdSchema,
  readBillingAccount,
} from "./billing-account.js";

const ORG = "4939211d-158a-48ae-8f9a-4b94a48ca221";
const SENSITIVE_COLUMN = /card|token|secret|key\b|password/iu;

const orgRow = {
  billing_account_id: "ba-1",
  created_at: "2026-06-01T00:00:00Z",
  credit_balance: 40,
  domain_balance: 3,
  id: ORG,
  inbox_balance: 9,
  lifetime_domains_purchased: 6,
  lifetime_domains_used: 3,
  lifetime_granted: 10,
  lifetime_inboxes_purchased: 12,
  lifetime_inboxes_used: 3,
  lifetime_purchased: 100,
  lifetime_used: 70,
  name: "bigE's Workspace",
  partner_id: null,
  provider: "autumn",
  subscription_plan: "pro",
  subscription_status: "active",
  trial_ends_at: null,
};

describe("read_billing_account", () => {
  it("accepts only a uuid", () => {
    assert.equal(organizationIdSchema.parse(` ${ORG.toUpperCase()} `), ORG);
    assert.equal(organizationIdSchema.safeParse("org 1; drop").success, false);
  });

  it("issues four statements bound to the same id and shapes the wallets", async () => {
    const queries: string[] = [];
    const result = await readBillingAccount(ORG, (query) => {
      queries.push(query);
      if (query.includes("from organization")) {
        return Promise.resolve(JSON.stringify([orgRow]));
      }
      if (query.includes("from credit_balance")) {
        return Promise.resolve(JSON.stringify([{ balance: 40 }]));
      }
      return Promise.resolve("[]");
    });
    assert.equal(queries.length, 4);
    assert.ok(queries.every((query) => query.includes(`'${ORG}'`)));
    assert.equal(result.found, true);
    assert.equal(result.organization?.partnerId, null);
    assert.deepEqual(result.billingAccount?.inboxes, {
      balance: 9,
      lifetimeGranted: null,
      lifetimePurchased: 12,
      lifetimeUsed: 3,
    });
    assert.equal(result.billingAccount?.credits.lifetimeGranted, 10);
    assert.deepEqual(result.truncated, {
      manualCredits: false,
      transactions: false,
    });
  });

  it("flags only the history list that hit its cap", async () => {
    const result = await readBillingAccount(ORG, (query) => {
      if (query.includes("from organization")) {
        return Promise.resolve(JSON.stringify([orgRow]));
      }
      if (query.includes("from credit_transaction")) {
        return Promise.resolve(
          JSON.stringify(
            Array.from({ length: HISTORY_LIMIT }, (_, i) => ({ amount: i }))
          )
        );
      }
      return Promise.resolve("[]");
    });
    assert.deepEqual(result.truncated, {
      manualCredits: false,
      transactions: true,
    });
    assert.equal(result.transactions.length, HISTORY_LIMIT);
  });

  it("returns found false for an unknown organization and error for a failed read", async () => {
    const missing = await readBillingAccount(ORG, () => Promise.resolve("[]"));
    assert.equal(missing.found, false);
    assert.equal(missing.error, undefined);
    const failed = await readBillingAccount(ORG, () =>
      Promise.reject(new Error("HTTP 500"))
    );
    assert.equal(failed.found, false);
    assert.equal(failed.error, "HTTP 500");
  });

  it("refuses a non-uuid in the query factory itself", () => {
    assert.throws(() => billingAccountQueries("org' OR 1=1 --"));
  });

  it("never selects a card, token, or key column", () => {
    for (const query of Object.values(billingAccountQueries(ORG))) {
      assert.doesNotMatch(query, SENSITIVE_COLUMN);
    }
  });
});
