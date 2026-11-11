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
/** The AI Acquisition client Slack reads, mirroring `.github/executor/specs/aia-slack.json`. */
const slackChannel = z.string().regex(/^[CG][A-Z0-9]{2,30}$/u);
const slackLimit = z.number().int().min(1).max(200);
const runs = {
  cursor: z.string().optional(),
  from: z.string().optional(),
  limit,
  status: z.string().optional(),
};
/** Typed helper schemas own their provider parameter placement; generic calls already use v2 input. */
const queryInput = <T extends z.ZodType>(schema: T) =>
  schema.transform((query) => ({ query }));
const workspaceQuery = <T extends { "x-as-workspace": string }>(input: T) => {
  const { "x-as-workspace": workspace, ...query } = input;
  return { headers: { "x-as-workspace": workspace }, query };
};
export const operationInputs = {
  "autumn.customer": z
    .object({
      body: z.object({ customer_id: id, expand: z.array(z.string()) }),
      "x-api-version": z.literal("2.3.0"),
    })
    .transform(({ body, "x-api-version": version }) => ({
      body,
      headers: { "x-api-version": version },
    })),
  "help.search": queryInput(z.object({ query: z.string().max(2000) })),
  "inngest.apps": queryInput(
    z.object({ cursor: z.string().optional(), limit })
  ),
  "inngest.functionRuns": z
    .object({ ...runs, appId: id, functionId: id })
    .transform(({ appId, functionId, ...query }) => ({
      path: { appId, functionId },
      query,
    })),
  "inngest.runs": queryInput(z.object(runs)),
  "inngest.trace": z
    .object({
      includeOutput: z.boolean().optional(),
      runId: id,
    })
    .transform(({ runId, ...query }) => ({ path: { runId }, query })),
  "instantly.accounts": z
    .object({
      ...resource,
      provider_code: z.number().int().optional(),
    })
    .transform(workspaceQuery),
  "instantly.campaigns": z.object(resource).transform(workspaceQuery),
  "instantly.emails": z
    .object({
      ...resource,
      campaign_id: z.string().optional(),
      eaccount: z.string().optional(),
      email_type: z.enum(["received", "sent", "manual"]).optional(),
      latest_of_thread: z.boolean().optional(),
      lead: z.string().optional(),
      max_timestamp_created: z.string().optional(),
      min_timestamp_created: z.string().optional(),
      preview_only: z.literal(true),
    })
    .transform(workspaceQuery),
  "instantly.workspace-group-members": queryInput(z.object(page)),
  "planetscale.readQuery": z.object({
    branch: id,
    database: id,
    organization: id,
    postgres_database_name: z.string().optional(),
    query: z.string(),
    use_replica: z.boolean().optional(),
  }),
  "sentry.issueDetails": z.object({ issueId: id, organizationSlug: id }),
  "sentry.issueEvents": z.object({
    issueId: id,
    limit,
    organizationSlug: id,
    period: z.string(),
    query: z.string(),
  }),
  "slack.aia.channels": queryInput(
    z.object({
      cursor: z.string().optional(),
      exclude_archived: z.boolean().optional(),
      limit: slackLimit.optional(),
      types: z.literal("private_channel"),
    })
  ),
  "slack.aia.history": queryInput(
    z.object({
      channel: slackChannel,
      cursor: z.string().optional(),
      inclusive: z.boolean().optional(),
      latest: z.string().optional(),
      limit: slackLimit.optional(),
      oldest: z.string().optional(),
    })
  ),
  "slack.aia.replies": queryInput(
    z.object({
      channel: slackChannel,
      cursor: z.string().optional(),
      latest: z.string().optional(),
      limit: slackLimit.optional(),
      oldest: z.string().optional(),
      ts: z.string().regex(/^\d{1,12}\.\d{1,8}$/u),
    })
  ),
  "slack.aia.user": queryInput(
    z.object({
      user: z.string().regex(/^[UW][A-Z0-9]{2,30}$/u),
    })
  ),
  "stripe.charges.get": z
    .object({
      charge_id: id,
      "expand[]": z.literal("refunds"),
    })
    .transform(({ charge_id, ...query }) => ({ path: { charge_id }, query })),
  "stripe.charges.list": queryInput(history),
  "stripe.coupons.get": z
    .object({ coupon_id: id })
    .transform((path) => ({ path })),
  "stripe.credit_notes.list": queryInput(history),
  "stripe.customers.balance_transactions": z
    .object({ customer_id: id, limit })
    .transform(({ customer_id, ...query }) => ({
      path: { customer_id },
      query,
    })),
  "stripe.customers.get": z
    .object({ customer_id: id })
    .transform((path) => ({ path })),
  "stripe.disputes.get": z
    .object({ dispute_id: id })
    .transform((path) => ({ path })),
  "stripe.invoices.list": queryInput(history),
  "stripe.promotion_codes.list": queryInput(z.object({ code: id, limit })),
  "stripe.refunds.get": z
    .object({ refund_id: id })
    .transform((path) => ({ path })),
  "stripe.subscriptions.list": queryInput(
    history.extend({ status: z.literal("all") })
  ),
  "vercel.billingCharges": queryInput(
    z.object({
      from: z.iso.datetime(),
      teamId: id,
      to: z.iso.datetime(),
    })
  ),
};

/** Stripe dispute evidence text fields Foreman may fill. */
export const DISPUTE_TEXT_FIELDS = [
  "access_activity_log",
  "billing_address",
  "cancellation_policy_disclosure",
  "cancellation_rebuttal",
  "customer_email_address",
  "customer_name",
  "customer_purchase_ip",
  "duplicate_charge_explanation",
  "product_description",
  "refund_policy_disclosure",
  "refund_refusal_explanation",
  "service_date",
  "uncategorized_text",
] as const;
/** Stripe dispute evidence file slots Foreman may fill, one file each. */
export const DISPUTE_FILE_SLOTS = [
  "cancellation_policy",
  "customer_communication",
  "receipt",
  "refund_policy",
  "service_documentation",
  "uncategorized_file",
] as const;

/**
 * The dispute writes, bound only in the foreman-disputes toolkit and reached
 * only by respond_stripe_dispute. Kept out of {@link operationInputs} so they
 * are never required of, or selected in, the shared toolkit. There is no
 * close, file link, or refund operation.
 */
export const disputeOperationInputs = {
  "stripe.disputes.update": z.strictObject({
    dispute_id: z.string().regex(/^du_[A-Za-z0-9]{1,64}$/u),
    evidence: z
      .partialRecord(
        z.enum([...DISPUTE_TEXT_FIELDS, ...DISPUTE_FILE_SLOTS]),
        z.string().max(20_000)
      )
      .optional(),
    // Stripe replays a repeated submit with the same key instead of sending it twice.
    "Idempotency-Key": z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,255}$/u)
      .optional(),
    metadata: z.record(z.string().max(40), z.string().max(500)).optional(),
    submit: z.boolean(),
  }),
  "stripe.files.create": z.strictObject({
    file: z.base64().max(7_000_000),
    purpose: z.literal("dispute_evidence"),
  }),
};

/**
 * The arguments Executor's dispute-write operations take, from validated
 * input: grouped path and header parameters, the request fields under
 * `body`, and the PDF as a `ToolFile` Executor sends as multipart.
 */
export const disputeWireArgs = (
  operation: keyof typeof disputeOperationInputs,
  input: unknown
): Record<string, unknown> => {
  if (operation === "stripe.files.create") {
    const { file, purpose } =
      disputeOperationInputs["stripe.files.create"].parse(input);
    return {
      body: {
        file: {
          _tag: "ToolFile",
          byteLength: Buffer.from(file, "base64").length,
          data: file,
          encoding: "base64",
          mimeType: "application/pdf",
          name: "evidence.pdf",
        },
        purpose,
      },
    };
  }
  const {
    dispute_id,
    "Idempotency-Key": idempotencyKey,
    ...body
  } = disputeOperationInputs["stripe.disputes.update"].parse(input);
  return {
    body,
    path: { dispute_id },
    ...(idempotencyKey
      ? { headers: { "Idempotency-Key": idempotencyKey } }
      : {}),
  };
};

type ApiRequest = {
  [K in keyof typeof operationInputs]: {
    operation: K;
    input: z.input<(typeof operationInputs)[K]>;
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
  retryable?: boolean;
  status: number;
}
export type ProviderClient = (
  request: OperationRequest,
  options?: {
    signal?: AbortSignal;
    /** Caps the parsed result. */
    maxBytes?: number;
    /** Caps the transport body instead of its 8 MiB default. */
    wireMaxBytes?: number;
  }
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
