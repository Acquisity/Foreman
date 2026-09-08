interface Policy {
  action: string;
  pattern: string;
  position: string;
}

interface Catalog {
  connectionPolicies: { pattern: string; blocked: string[] }[];
  paths: string[];
}

const connectionPattern = (path: string) =>
  `${path.split(".").slice(0, 3).join(".")}.*`;

// Operator configuration audit only; this does not authorize runtime calls.
export const toolkitPolicyMatches = (
  expected: Catalog,
  policies: Policy[],
  connections: { pattern: string }[]
): boolean => {
  const rules = new Map(policies.map((rule) => [rule.pattern, rule]));
  const fallback = rules.get("*");
  const prefixes = new Set(expected.paths.map(connectionPattern));
  if (
    rules.size !== policies.length ||
    new Set(policies.map((rule) => rule.position)).size !== policies.length ||
    fallback?.action !== "block" ||
    connections.length !== prefixes.size ||
    new Set(connections.map((connection) => connection.pattern)).size !==
      prefixes.size ||
    !connections.every((connection) => prefixes.has(connection.pattern))
  ) {
    return false;
  }

  const declared = new Map(
    expected.connectionPolicies.map((scope) => [scope.pattern, scope])
  );
  if (declared.size !== expected.connectionPolicies.length) {
    return false;
  }
  const permitted = new Set(["*", ...expected.paths]);
  for (const scope of declared.values()) {
    const allow = rules.get(scope.pattern);
    if (
      !prefixes.has(scope.pattern) ||
      allow?.action !== "approve" ||
      allow.position >= fallback.position ||
      new Set(scope.blocked).size !== scope.blocked.length
    ) {
      return false;
    }
    permitted.add(scope.pattern);
    const blocksMatch = scope.blocked.every((path) => {
      const block = rules.get(path);
      return (
        !path.includes("*") &&
        connectionPattern(path) === scope.pattern &&
        !expected.paths.includes(path) &&
        block?.action === "block" &&
        block.position < allow.position
      );
    });
    if (!blocksMatch) {
      return false;
    }
    for (const path of scope.blocked) {
      permitted.add(path);
    }
  }
  for (const path of expected.paths) {
    const exact = rules.get(path);
    if (
      path.includes("*") ||
      (exact &&
        (exact.action !== "approve" || exact.position >= fallback.position))
    ) {
      return false;
    }
    if (!(exact || declared.has(connectionPattern(path)))) {
      return false;
    }
  }
  return policies.every((rule) => permitted.has(rule.pattern));
};
