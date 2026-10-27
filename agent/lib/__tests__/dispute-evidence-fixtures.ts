import assert from "node:assert/strict";
import {
  type DisputeEvidence,
  type EvidenceDeps,
  gatherDisputeEvidence,
} from "../dispute-evidence.js";
import type { ProviderResult } from "../executor/operations.js";
export const NOW = Date.parse("2026-10-27T12:00:00Z");
export const CHARGE = Date.parse("2026-10-04T00:00:00Z") / 1000;
export const BA = "0b6c6f4e-3c1a-4d8e-9a77-2f1e5d4c3b2a";
export const ORG_A = "11111111-1111-4111-8111-111111111111";
export const ORG_B = "22222222-2222-4222-8222-222222222222";
export const AFTER = "2026-10-10 09:00:00+00";
export const BEFORE = "2026-09-20 09:00:00+00";

export type Obj = Record<string, unknown>;

export interface World {
  autumnId?: string;
  charge?: Obj;
  charges?: Obj[];
  email?: string;
  failSql?: RegExp;
  invoices?: Obj[];
  linearDescription?: string;
  slackChannels?: Obj[];
  slackError?: string;
  slackMessages?: Obj[];
  subscriptions?: Obj[];
  /** Rows by table, or by `table@organization` for one workspace. */
  tables?: Record<string, Obj[]>;
}

export const json = (data: unknown, status = 200): Promise<ProviderResult> =>
  Promise.resolve({ data, status });

export const TABLE = /\bfrom ("user"|[a-z_]+)/u;
const COMBINED_TABLE =
  /from \((select[\s\S]*?)\) evidence_rows\) as "([^"]+)"/gu;
const ORG = /organization_id = '([^']+)'/u;
/** A fake of every provider; `calls` records each read in order. */
export const fake = (world: World = {}) => {
  const calls: string[] = [];
  const queries: string[] = [];
  const tables: Record<string, Obj[]> = {
    domain_purchase_order: [
      {
        created_at: "2026-09-01 00:00:00+00",
        id: "order-1",
        organization_id: ORG_A,
        paid_at: "2026-09-01 00:00:00+00",
      },
    ],
    organization: [{ billing_account_id: BA, id: ORG_A, name: "Acme" }],
    ...world.tables,
  };
  const deps: EvidenceDeps = {
    linear: (request) => {
      calls.push(request.operation);
      if (request.operation === "linear.RelatedIssues") {
        return json({
          data: {
            issues: {
              nodes: [
                {
                  assignee: null,
                  createdAt: "2026-10-12T00:00:00Z",
                  id: "i1",
                  identifier: "CSP-12",
                  labels: { nodes: [] },
                  parent: null,
                  state: { name: "Done", type: "completed" },
                  title: "Refund request",
                  url: "https://linear.app/x/CSP-12",
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        });
      }
      return json({
        data: {
          issues: {
            nodes: [
              {
                comments: {
                  nodes: [
                    {
                      body: "We will not refund.",
                      createdAt: "2026-10-13T00:00:00Z",
                      user: { name: "Support" },
                    },
                  ],
                },
                createdAt: "2026-10-12T00:00:00Z",
                description:
                  world.linearDescription ??
                  "Customer asks for a refund. owner@acme.io",
                identifier: "CSP-12",
                state: { name: "Done" },
                title: "Refund request",
                url: "https://linear.app/x/CSP-12",
              },
            ],
          },
        },
      });
    },
    now: () => NOW,
    read: (request) => {
      calls.push(request.operation);
      switch (request.operation) {
        case "stripe.disputes.get":
          return json({
            amount: 25_200,
            charge: "ch_1",
            evidence_details: { due_by: NOW / 1000 + 86_400 },
            id: "du_1",
            reason: "fraudulent",
            status: "needs_response",
          });
        case "stripe.charges.get":
          return json({
            amount: 25_200,
            amount_refunded: 0,
            billing_details: { email: "card@example.com", name: "Abdul" },
            created: CHARGE,
            customer: "cus_1",
            id: "ch_1",
            invoice: "in_1",
            refunds: { data: [] },
            ...world.charge,
          });
        case "stripe.customers.get":
          return json({
            email: world.email ?? "owner@acme.io",
            metadata: { autumn_id: world.autumnId ?? BA },
            name: "Owner",
          });
        case "stripe.invoices.list":
          return json({
            data: world.invoices ?? [
              {
                id: "in_1",
                lines: {
                  data: [
                    { period: { end: 2, start: 1 }, subscription: "sub_1" },
                  ],
                },
                subscription: "sub_1",
              },
            ],
            has_more: false,
          });
        case "stripe.subscriptions.list":
          return json({ data: world.subscriptions ?? [], has_more: false });
        case "stripe.charges.list":
          return json({ data: world.charges ?? [], has_more: false });
        case "stripe.credit_notes.list":
          return json({ data: [], has_more: false });
        case "autumn.customer":
          return json({ id: BA, purchases: [], subscriptions: [] });
        default:
          return Promise.reject(new Error(`unexpected ${request.operation}`));
      }
    },
    slack: (request) => {
      calls.push(request.operation);
      if (world.slackError) {
        return json({ error: world.slackError, ok: false });
      }
      switch (request.operation) {
        case "slack.aia.channels":
          return json({
            channels: world.slackChannels ?? [
              { id: "G0ACME", name: "acme-io-client" },
              { id: "G0BETA", name: "beta-co" },
            ],
            ok: true,
            response_metadata: { next_cursor: "" },
          });
        case "slack.aia.history":
          return json({
            messages: world.slackMessages ?? [
              {
                reply_count: 1,
                text: "Domains are live",
                ts: "1759800000.000100",
                user: "U0STAFF",
              },
            ],
            ok: true,
          });
        case "slack.aia.replies":
          return json({
            messages: [
              { text: "Domains are live", ts: "1759800000.000100" },
              { text: "Thanks!", ts: "1759800100.000100", user: "U0CLIENT" },
            ],
            ok: true,
          });
        default:
          return json({ ok: true, user: { real_name: "Staff" } });
      }
    },
    sql: (query) => {
      calls.push("sql");
      queries.push(query);
      if (world.failSql?.test(query)) {
        return Promise.reject(new Error("PlanetScale answered HTTP 422."));
      }
      const combined: Obj = {};
      for (const [, inner, alias] of query.matchAll(COMBINED_TABLE)) {
        const table = TABLE.exec(inner)?.[1] ?? "";
        const org = ORG.exec(inner)?.[1];
        combined[alias] =
          (org && tables[`${table}@${org}`]) || tables[table] || [];
      }
      return Promise.resolve(JSON.stringify([combined]));
    },
  };
  return { calls, deps, queries };
};

export const gather = (world?: World) => {
  const stub = fake(world);
  return gatherDisputeEvidence("du_1", stub.deps).then((result) => ({
    ...stub,
    result,
  }));
};

export const facts = <K extends keyof DisputeEvidence["sources"]>(
  result: DisputeEvidence,
  source: K
) => {
  const read = result.sources[source];
  assert.ok(read.checked, `${source} failed: ${!read.checked && read.error}`);
  return read.facts as Extract<
    DisputeEvidence["sources"][K],
    { checked: true }
  >["facts"];
};
