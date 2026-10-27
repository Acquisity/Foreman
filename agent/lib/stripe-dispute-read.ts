import { z } from "zod";
import type { OperationRequest } from "./executor/operations.js";
import { ExecutorError } from "./executor/transport.js";

/**
 * The Stripe dispute reads shared by `respond_stripe_dispute` and
 * `gather_dispute_evidence` (ENG-16494), so identity and refund facts come
 * from one place. Reads stay on the raw Executor client: the billing helper's
 * sanitizer strips `billing_details` and the customer's email and name.
 */

export const DISPUTE_ID = /^du_[A-Za-z0-9]{1,64}$/u;

/** Cap on each parsed read, and on the evidence tool's whole response. */
export const READ_BYTES = 256 * 1024;

export const disputeSchema = z.looseObject({
  amount: z.number().optional(),
  charge: z.union([z.string(), z.looseObject({ id: z.string() })]).nullish(),
  created: z.number().optional(),
  currency: z.string().optional(),
  evidence: z.record(z.string(), z.unknown()).default({}),
  evidence_details: z
    .looseObject({
      due_by: z.number().nullish(),
      has_evidence: z.boolean().optional(),
      past_due: z.boolean().optional(),
      submission_count: z.number().nullish(),
    })
    .optional(),
  id: z.string(),
  metadata: z.record(z.string(), z.string()).default({}),
  payment_method_details: z
    .looseObject({
      card: z
        .looseObject({
          brand: z.string().nullish(),
          network_reason_code: z.string().nullish(),
        })
        .nullish(),
    })
    .nullish(),
  reason: z.string().optional(),
  status: z.string(),
});
export type StripeDispute = z.infer<typeof disputeSchema>;

/** Shared-toolkit reads, returning the raw Stripe object. */
export interface StripeReadDeps {
  readonly read: (
    request: OperationRequest
  ) => Promise<{ data: unknown; status: number }>;
}

export const readDispute = async (
  deps: StripeReadDeps,
  disputeId: string
): Promise<StripeDispute> => {
  const response = await deps.read({
    input: { dispute_id: disputeId },
    operation: "stripe.disputes.get",
  });
  if (response.status !== 200) {
    throw new Error(`Stripe dispute read failed with HTTP ${response.status}.`);
  }
  return disputeSchema.parse(response.data);
};

export const errorReason = (error: unknown): string => {
  if (error instanceof ExecutorError) {
    if (
      error.code === "operation_not_bound" ||
      error.code === "operation_bindings_missing"
    ) {
      return `The Stripe dispute write is not provisioned yet (${error.code}). An operator has to bind it in the foreman-disputes toolkit.`;
    }
    return `Executor could not complete the call (${error.code}).`;
  }
  return error instanceof Error ? error.message : "The call could not run.";
};

export const stripeDate = (seconds: unknown): string | null =>
  typeof seconds === "number" &&
  Number.isFinite(seconds) &&
  Math.abs(seconds * 1000) <= 8.64e15
    ? new Date(seconds * 1000).toISOString()
    : null;
export const stripeId = (value: unknown): string | null => {
  if (typeof value === "string") {
    return value;
  }
  return value &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "string"
    ? value.id
    : null;
};

interface StripeRefund {
  amount?: number;
  created?: number;
  id?: string;
  status?: string;
}

/**
 * The cardholder on the charge, the Stripe customer with its Autumn id, and
 * the charge's amount and refunds from the same expanded read.
 */
export const lookupIdentity = async (
  deps: StripeReadDeps,
  chargeId: string | null,
  options: { includeMetadata?: boolean } = {}
) => {
  if (!chargeId) {
    return { error: "The dispute names no charge." };
  }
  try {
    const charge = await deps.read({
      input: { charge_id: chargeId, "expand[]": "refunds" },
      operation: "stripe.charges.get",
    });
    const data = (charge.data ?? {}) as {
      metadata?: Record<string, string>;
      amount?: number;
      amount_refunded?: number;
      billing_details?: { email?: string | null; name?: string | null };
      created?: number;
      customer?: string | null;
      invoice?: string | { id: string } | null;
      payment_intent?: string | { id: string } | null;
      refunds?: { data?: StripeRefund[] } | null;
    };
    if (charge.status !== 200) {
      return { error: `Stripe charge read failed with HTTP ${charge.status}.` };
    }
    const cardholder = {
      email: data.billing_details?.email ?? null,
      name: data.billing_details?.name ?? null,
    };
    const chargeFacts = {
      ...(options.includeMetadata ? { metadata: data.metadata ?? {} } : {}),
      amount: data.amount ?? null,
      amountRefunded: data.amount_refunded ?? 0,
      created: stripeDate(data.created),
      id: chargeId,
      invoice: stripeId(data.invoice),
      paymentIntent: stripeId(data.payment_intent),
      refunds: (data.refunds?.data ?? []).map((refund) => ({
        amount: refund.amount ?? null,
        created: stripeDate(refund.created),
        id: refund.id ?? null,
        status: refund.status ?? null,
      })),
    };
    if (!data.customer) {
      return { cardholder, charge: chargeFacts, customer: null };
    }
    const customer = await deps.read({
      input: { customer_id: data.customer },
      operation: "stripe.customers.get",
    });
    const record = (customer.data ?? {}) as {
      email?: string | null;
      metadata?: Record<string, string>;
      name?: string | null;
    };
    return {
      cardholder,
      charge: chargeFacts,
      customer:
        customer.status === 200
          ? {
              autumnId: record.metadata?.autumn_id ?? null,
              email: record.email ?? null,
              id: data.customer,
              name: record.name ?? null,
            }
          : {
              error: `Stripe customer read failed with HTTP ${customer.status}.`,
            },
    };
  } catch (error) {
    return { error: errorReason(error) };
  }
};
export type DisputeIdentity = Awaited<ReturnType<typeof lookupIdentity>>;
