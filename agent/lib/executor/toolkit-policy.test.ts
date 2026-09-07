import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toolkitPolicyMatches } from "./toolkit-policy.js";

const prefix = "vercel.user.foreman";
const read = `${prefix}.projects.getProject`;
const remove = `${prefix}.projects.deleteProject`;
const pattern = `${prefix}.*`;
const connections = [{ pattern }];
const catalog = {
  connectionPolicies: [{ blocked: [remove], pattern }],
  paths: [read],
};
const policies = [
  { action: "block", pattern: remove, position: "a" },
  { action: "approve", pattern, position: "b" },
  { action: "block", pattern: "*", position: "z" },
];

describe("toolkit policy audit", () => {
  it("accepts an exact catalog with default deny", () => {
    assert.equal(
      toolkitPolicyMatches(
        { connectionPolicies: [], paths: [read] },
        [{ action: "approve", pattern: read, position: "a" }, policies[2]],
        connections
      ),
      true
    );
  });

  it("accepts declared connection access with destructive exceptions and redundant safe exact allows", () => {
    assert.equal(toolkitPolicyMatches(catalog, policies, connections), true);
    assert.equal(
      toolkitPolicyMatches(
        catalog,
        [...policies, { action: "approve", pattern: read, position: "c" }],
        connections
      ),
      true
    );
  });

  it("rejects missing or ineffective destructive blocks", () => {
    assert.equal(
      toolkitPolicyMatches(catalog, policies.slice(1), connections),
      false
    );
    assert.equal(
      toolkitPolicyMatches(
        catalog,
        [{ ...policies[0], position: "c" }, ...policies.slice(1)],
        connections
      ),
      false
    );
    assert.equal(
      toolkitPolicyMatches(
        catalog,
        [{ ...policies[0], action: "approve" }, ...policies.slice(1)],
        connections
      ),
      false
    );
  });

  it("rejects unexpected access and missing default deny", () => {
    for (const extra of [
      { action: "approve", pattern: "*.*", position: "d" },
      { action: "approve", pattern: `${prefix}.newTool`, position: "d" },
    ]) {
      assert.equal(
        toolkitPolicyMatches(catalog, [...policies, extra], connections),
        false
      );
    }
    assert.equal(
      toolkitPolicyMatches(catalog, policies.slice(0, 2), connections),
      false
    );
    assert.equal(
      toolkitPolicyMatches(
        catalog,
        [...policies.slice(0, 2), { ...policies[2], position: "0" }],
        connections
      ),
      false
    );
  });

  it("rejects duplicate rules, conflicting exact rules, and unexpected mounts", () => {
    assert.equal(
      toolkitPolicyMatches(catalog, [...policies, policies[0]], connections),
      false
    );
    assert.equal(
      toolkitPolicyMatches(
        catalog,
        [...policies, { action: "block", pattern: read, position: "c" }],
        connections
      ),
      false
    );
    assert.equal(
      toolkitPolicyMatches(catalog, policies, [...connections, ...connections]),
      false
    );
    assert.equal(
      toolkitPolicyMatches(catalog, policies, [
        { pattern: "other.user.account.*" },
      ]),
      false
    );
  });

  it("rejects exclusions outside their declared connection or also selected as allowed", () => {
    assert.equal(
      toolkitPolicyMatches(
        { ...catalog, paths: [read, remove] },
        policies,
        connections
      ),
      false
    );
    assert.equal(
      toolkitPolicyMatches(
        {
          ...catalog,
          connectionPolicies: [
            { blocked: ["other.user.account.deleteProject"], pattern },
          ],
        },
        policies,
        connections
      ),
      false
    );
  });
});
