import { z } from "zod";
import {
  LINEAR_OPERATIONS,
  type LinearOperation,
} from "../linear-operations.js";

const id = z.string().min(1).max(500);
const limit = z.number().int().positive().max(1000);
const history = z.object({
  customer: id,
  limit,
});
const page = { limit, starting_after: z.string().optional() };
const resource = {
  ...page,
  search: z.string().optional(),
  status: z.number().int().optional(),
  "x-as-workspace": id,
};
const runs = {
  cursor: z.string().optional(),
  from: z.string().optional(),
  limit,
  status: z.string().optional(),
};
export const operationInputs = {
  "autumn.customer": z.object({
    body: z.object({ customer_id: id, expand: z.array(z.string()) }),
    "x-api-version": z.literal("2.3.0"),
  }),
  "help.search": z.object({ query: z.string().max(2000) }),
  "inngest.apps": z.object({ cursor: z.string().optional(), limit }),
  "inngest.functionRuns": z.object({ ...runs, appId: id, functionId: id }),
  "inngest.runs": z.object(runs),
  "inngest.trace": z.object({
    includeOutput: z.boolean().optional(),
    runId: id,
  }),
  "instantly.accounts": z.object({
    ...resource,
    provider_code: z.number().int().optional(),
  }),
  "instantly.campaigns": z.object(resource),
  "instantly.emails": z.object({
    ...resource,
    campaign_id: z.string().optional(),
    eaccount: z.string().optional(),
    email_type: z.enum(["received", "sent", "manual"]).optional(),
    latest_of_thread: z.boolean().optional(),
    lead: z.string().optional(),
    max_timestamp_created: z.string().optional(),
    min_timestamp_created: z.string().optional(),
    preview_only: z.literal(true),
  }),
  "instantly.workspace-group-members": z.object(page),
  "planetscale.readQuery": z.object({
    branch: id,
    database: id,
    organization: id,
    postgres_database_name: z.string().optional(),
    query: z.string(),
    use_replica: z.boolean().optional(),
  }),
  "sentry.issueRead": z.object({
    arguments: z.record(z.string(), z.unknown()),
    name: z.enum(["get_issue_details", "search_issue_events"]),
  }),
  "stripe.charges.get": z.object({
    charge_id: id,
    "expand[]": z.literal("refunds"),
  }),
  "stripe.charges.list": history,
  "stripe.coupons.get": z.object({ coupon_id: id }),
  "stripe.credit_notes.list": history,
  "stripe.customers.balance_transactions": z.object({ customer_id: id, limit }),
  "stripe.customers.get": z.object({ customer_id: id }),
  "stripe.disputes.get": z.object({ dispute_id: id }),
  "stripe.invoices.list": history,
  "stripe.promotion_codes.list": z.object({ code: id, limit }),
  "stripe.refunds.get": z.object({ refund_id: id }),
  "stripe.subscriptions.list": history.extend({ status: z.literal("all") }),
};

type ApiRequest = {
  [K in keyof typeof operationInputs]: {
    operation: K;
    input: z.infer<(typeof operationInputs)[K]>;
  };
}[keyof typeof operationInputs];
export type OperationRequest =
  | ApiRequest
  | {
      operation: `linear.${LinearOperation}`;
      input: { variables: Record<string, unknown> };
    };
export interface ProviderResult {
  data: unknown;
  retryAfter?: string;
  status: number;
}
export type ProviderClient = (
  request: OperationRequest,
  options?: { signal?: AbortSignal; maxBytes?: number }
) => Promise<ProviderResult>;
export function requiredClient(client?: ProviderClient): ProviderClient {
  if (!client) {
    throw new Error("Executor client is required for this provider operation.");
  }
  return client;
}

export const REQUIRED_HELPER_OPERATIONS = [
  ...Object.keys(operationInputs),
  ...Object.keys(LINEAR_OPERATIONS).map((name) => `linear.${name}`),
];
