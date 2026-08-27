import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildLookupCustomerQuery,
  customerEmailSchema,
  lookupCustomer,
  MEMBERSHIP_LIMIT,
} from "./lookup-customer.js";

const row = (organizationId: string | null, role = "owner") => ({
  email: "ada@example.com",
  organization_created_at: "2026-01-01T00:00:00Z",
  organization_id: organizationId,
  organization_name: organizationId ? `Org ${organizationId}` : null,
  role: organizationId ? role : null,
  user_created_at: "2025-12-01T00:00:00Z",
  user_id: "u1",
  user_name: "Ada",
});

describe("lookup_customer", () => {
  it("lowercases and trims the email before binding it", async () => {
    assert.equal(
      customerEmailSchema.parse("  Ada@Example.COM "),
      "ada@example.com"
    );
    assert.equal(customerEmailSchema.safeParse("not an email").success, false);
    assert.equal(customerEmailSchema.safeParse("a'b@x.com").success, false);

    let query = "";
    await lookupCustomer("ada@example.com", (sql) => {
      query = sql;
      return Promise.resolve("[]");
    });
    assert.ok(query.includes("where lower(u.email) = 'ada@example.com'"));
    assert.ok(buildLookupCustomerQuery("o''x@y.z").includes("'o''''x@y.z'"));
  });

  it("pins the organization when exactly one membership exists", async () => {
    const result = await lookupCustomer("ada@example.com", () =>
      Promise.resolve(JSON.stringify([row("org1")]))
    );
    assert.equal(result.found, true);
    assert.equal(result.ambiguous, false);
    assert.equal(result.pinnedOrganizationId, "org1");
    assert.equal(result.user?.id, "u1");
    assert.equal(result.memberships[0]?.role, "owner");
  });

  it("marks two memberships ambiguous with no pin", async () => {
    const result = await lookupCustomer("ada@example.com", () =>
      Promise.resolve(JSON.stringify({ rows: [row("org1"), row("org2")] }))
    );
    assert.equal(result.ambiguous, true);
    assert.equal(result.pinnedOrganizationId, null);
    assert.equal(result.memberships.length, 2);
  });

  it("reports a user with no live membership as found but unpinned", async () => {
    const result = await lookupCustomer("ada@example.com", () =>
      Promise.resolve(JSON.stringify([row(null)]))
    );
    assert.equal(result.found, true);
    assert.deepEqual(result.memberships, []);
    assert.equal(result.pinnedOrganizationId, null);
  });

  it("returns found false for no rows and error for a failed query", async () => {
    const empty = await lookupCustomer("ada@example.com", () =>
      Promise.resolve("[]")
    );
    assert.equal(empty.found, false);
    assert.equal(empty.error, undefined);

    const failed = await lookupCustomer("ada@example.com", () =>
      Promise.reject(new Error("HTTP 500"))
    );
    assert.equal(failed.found, false);
    assert.equal(failed.error, "HTTP 500");

    const drifted = await lookupCustomer("ada@example.com", () =>
      Promise.resolve(JSON.stringify([{ nope: 1 }]))
    );
    assert.equal(drifted.found, false);
    assert.ok(drifted.error);
  });

  it("flags a membership list that hit the cap", async () => {
    const rows = Array.from({ length: MEMBERSHIP_LIMIT }, (_, i) =>
      row(`org${i}`)
    );
    const result = await lookupCustomer("ada@example.com", () =>
      Promise.resolve(JSON.stringify(rows))
    );
    assert.equal(result.truncated, true);
    assert.equal(result.ambiguous, true);
  });
});
