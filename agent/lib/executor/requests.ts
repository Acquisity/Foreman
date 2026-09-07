import type { SessionAuthContext } from "eve/context";
import { z } from "zod";
import {
  canUseBillingApiRead,
  canUseInvestigationMemory,
  isAutonomous,
  isUnattended,
} from "../trust.js";
import { ExecutorError } from "./transport.js";

export type Provider =
  | "autumn"
  | "stripe"
  | "instantly"
  | "inngest"
  | "linear"
  | "help";
const ORIGINS: Record<Provider, string> = {
  autumn: "https://api.useautumn.com",
  help: "https://app.acquisity.ai",
  inngest: "https://api.inngest.com",
  instantly: "https://api.instantly.ai",
  linear: "https://api.linear.app",
  stripe: "https://api.stripe.com",
};
const LINEAR_READS = [
  "RelatedIssues",
  "IssueDocuments",
  "Document",
  "RouteIssue",
  "TeamLabels",
  "WorkflowStates",
  "Projects",
  "Users",
];
const LINEAR_WRITES = [
  "CreateDocument",
  "UpdateDocument",
  "RouteIssueUpdate",
  "RouteRelation",
  "RouteAttachment",
];
const requestBody = (init: RequestInit): Record<string, unknown> => {
  if (init.body === undefined || init.body === null) {
    return {};
  }
  if (typeof init.body !== "string" || init.body.length > 100_000) {
    throw new ExecutorError("invalid_helper_request");
  }
  return z.record(z.string(), z.unknown()).parse(JSON.parse(init.body));
};

interface Route {
  keys?: readonly string[];
  method?: string;
  operation: string;
  pattern: RegExp;
  provider: Provider;
}
const ROUTES: readonly Route[] = [
  {
    method: "POST",
    operation: "autumn.customer",
    pattern: /^\/v1\/customers\.get$/u,
    provider: "autumn",
  },
  { operation: "help.search", pattern: /^\/api\/search$/u, provider: "help" },
  {
    keys: ["id"],
    operation: "stripe.customers.get",
    pattern: /^\/v1\/customers\/([^/]+)$/u,
    provider: "stripe",
  },
  {
    keys: ["id"],
    operation: "stripe.customers.balance_transactions",
    pattern: /^\/v1\/customers\/([^/]+)\/balance_transactions$/u,
    provider: "stripe",
  },
  {
    keys: ["id"],
    operation: "stripe.charges.get",
    pattern: /^\/v1\/charges\/([^/]+)$/u,
    provider: "stripe",
  },
  {
    keys: ["id"],
    operation: "stripe.refunds.get",
    pattern: /^\/v1\/refunds\/([^/]+)$/u,
    provider: "stripe",
  },
  {
    keys: ["id"],
    operation: "stripe.disputes.get",
    pattern: /^\/v1\/disputes\/([^/]+)$/u,
    provider: "stripe",
  },
  {
    keys: ["id"],
    operation: "stripe.coupons.get",
    pattern: /^\/v1\/coupons\/([^/]+)$/u,
    provider: "stripe",
  },
  {
    operation: "stripe.subscriptions.list",
    pattern: /^\/v1\/subscriptions$/u,
    provider: "stripe",
  },
  {
    operation: "stripe.invoices.list",
    pattern: /^\/v1\/invoices$/u,
    provider: "stripe",
  },
  {
    operation: "stripe.charges.list",
    pattern: /^\/v1\/charges$/u,
    provider: "stripe",
  },
  {
    operation: "stripe.credit_notes.list",
    pattern: /^\/v1\/credit_notes$/u,
    provider: "stripe",
  },
  {
    operation: "stripe.promotion_codes.list",
    pattern: /^\/v1\/promotion_codes$/u,
    provider: "stripe",
  },
  {
    operation: "instantly.workspace-group-members",
    pattern: /^\/api\/v2\/workspace-group-members$/u,
    provider: "instantly",
  },
  {
    operation: "instantly.accounts",
    pattern: /^\/api\/v2\/accounts$/u,
    provider: "instantly",
  },
  {
    operation: "instantly.campaigns",
    pattern: /^\/api\/v2\/campaigns$/u,
    provider: "instantly",
  },
  {
    operation: "instantly.emails",
    pattern: /^\/api\/v2\/emails$/u,
    provider: "instantly",
  },
  { operation: "inngest.apps", pattern: /^\/v2\/apps$/u, provider: "inngest" },
  { operation: "inngest.runs", pattern: /^\/v2\/runs$/u, provider: "inngest" },
  {
    keys: ["appId", "functionId"],
    operation: "inngest.functionRuns",
    pattern: /^\/v2\/apps\/([^/]+)\/functions\/([^/]+)\/runs$/u,
    provider: "inngest",
  },
  {
    keys: ["runId"],
    operation: "inngest.trace",
    pattern: /^\/v2\/runs\/([^/]+)\/trace$/u,
    provider: "inngest",
  },
];
const GRAPHQL_OPERATION = /^(query|mutation) ([A-Za-z]+)\b/u;
export const REQUIRED_HELPER_OPERATIONS = [
  ...ROUTES.map((route) => route.operation),
  ...[...LINEAR_READS, ...LINEAR_WRITES].map((name) => `linear.${name}`),
  "planetscale.readQuery",
];

function identifyOperation(
  provider: Provider,
  url: URL,
  method: string,
  body: Record<string, unknown>
) {
  if (
    provider === "linear" &&
    method === "POST" &&
    url.pathname === "/graphql"
  ) {
    const match =
      typeof body.query === "string"
        ? GRAPHQL_OPERATION.exec(body.query)
        : null;
    if (
      match &&
      (match[1] === "query" ? LINEAR_READS : LINEAR_WRITES).includes(match[2])
    ) {
      return { operation: `linear.${match[2]}`, path: {} };
    }
  }
  for (const route of ROUTES) {
    if (route.provider !== provider || (route.method ?? "GET") !== method) {
      continue;
    }
    const match = route.pattern.exec(url.pathname);
    if (match) {
      return {
        operation: route.operation,
        path: Object.fromEntries(
          (route.keys ?? []).map((key, index) => [
            key,
            decodeURIComponent(match[index + 1]),
          ])
        ),
      };
    }
  }
  throw new ExecutorError("unsupported_helper_operation");
}

/** Fixed request descriptors are mapped to operations; these URLs are never fetched. */
export function resolveProviderRequest(
  provider: Provider,
  address: string,
  init: RequestInit
) {
  const url = new URL(address);
  const origin =
    provider === "help"
      ? new URL(process.env.ACQUISITY_WEB_BASE_URL ?? ORIGINS.help).origin
      : ORIGINS[provider];
  if (url.origin !== origin || url.username || url.password || url.hash) {
    throw new ExecutorError("invalid_helper_origin");
  }
  const body = requestBody(init);
  const { operation, path } = identifyOperation(
    provider,
    url,
    init.method ?? "GET",
    body
  );
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    query[key] = values.length > 1 || key.endsWith("[]") ? values : values[0];
  }
  const headers: Record<string, string> = {};
  const supplied = new Headers(init.headers);
  for (const name of ["x-api-version", "x-as-workspace"]) {
    const value = supplied.get(name);
    if (value !== null) {
      headers[name] = value;
    }
  }
  return { operation, source: { body, headers, path, query } };
}

export function authorizeHelper(
  operation: string,
  auth: SessionAuthContext | null
): void {
  if (
    (operation.startsWith("autumn.") || operation.startsWith("stripe.")) &&
    !canUseBillingApiRead(auth)
  ) {
    throw new ExecutorError("billing_denied");
  }
  if (operation.startsWith("instantly.") && !canUseInvestigationMemory(auth)) {
    throw new ExecutorError("instantly_denied");
  }
  if (
    operation.startsWith("linear.") &&
    (isAutonomous(auth) ||
      (isUnattended(auth) && LINEAR_WRITES.includes(operation.slice(7))))
  ) {
    throw new ExecutorError("linear_denied");
  }
}
