import { z } from "zod";
import {
  type OperationRequest,
  type ProviderClient,
  type ProviderResult,
  requiredClient,
} from "./executor/operations.js";
import { ExecutorError } from "./executor/transport.js";

const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const SENSITIVE_RESPONSE_KEYS = new Set([
  "address",
  "billing_address",
  "billing_details",
  "client_secret",
  "customer_email",
  "customer_email_address",
  "customer_name",
  "customer_purchase_ip",
  "default_payment_method",
  "default_source",
  "destination_details",
  "email",
  "payment_method",
  "payment_method_details",
  "phone",
  "receipt_email",
  "receipt_url",
  "shipping",
  "shipping_address",
  "sources",
]);

const sanitize = (
  value: unknown,
  rootSensitiveKeys: ReadonlySet<string>,
  atRoot = true
): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitize(entry, rootSensitiveKeys, false));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const isStripeCharge = "object" in value && value.object === "charge";
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !(
            SENSITIVE_RESPONSE_KEYS.has(key) ||
            (key === "source" && isStripeCharge) ||
            (atRoot && rootSensitiveKeys.has(key))
          )
      )
      .map(([key, entry]) => [key, sanitize(entry, rootSensitiveKeys, false)])
  );
};

const tooMuchData = (provider: "Autumn" | "Stripe"): Error =>
  new Error(
    `${provider} returned too much data. Narrow the lookup before concluding.`
  );

const enforceOutputBudget = <T>(provider: "Autumn" | "Stripe", value: T): T => {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_RESPONSE_BYTES) {
    throw tooMuchData(provider);
  }
  return value;
};

/** A safe billing-provider error. Response bodies never reach the model. */
export class BillingApiError extends Error {
  readonly status: number | null;

  constructor(
    provider: "Autumn" | "Stripe",
    status: number | null,
    options?: ErrorOptions
  ) {
    super(
      status === null
        ? `${provider} could not be reached.`
        : `${provider} read failed with HTTP ${status}.`,
      options
    );
    this.name = "BillingApiError";
    this.status = status;
  }
}

const parseResponse = (
  provider: "Autumn" | "Stripe",
  response: ProviderResult,
  rootSensitiveKeys: ReadonlySet<string>
): unknown => {
  if (response.status < 200 || response.status >= 300) {
    throw new BillingApiError(provider, response.status);
  }
  enforceOutputBudget(provider, response.data);
  return sanitize(response.data, rootSensitiveKeys);
};

const call = async (
  provider: "Autumn" | "Stripe",
  request: OperationRequest,
  options: { client?: ProviderClient; signal?: AbortSignal },
  rootSensitiveKeys: ReadonlySet<string> = new Set()
): Promise<unknown> => {
  // The caller's signal stays in `options` so cancellation is still recognized
  // after the deadline is composed in; only the request carries both. The
  // failure is classified from the composed signal's first abort reason, which
  // never changes once set: a caller that aborts after the deadline fired
  // cannot turn the timeout into a cancellation, and an unrelated error merely
  // named TimeoutError never becomes the deadline message. The deadline is its
  // own controller so that reason is an identity the catch can compare.
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(
        new DOMException("The operation timed out.", "TimeoutError")
      ),
    REQUEST_TIMEOUT_MS
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  try {
    return await parseResponse(
      provider,
      await requiredClient(options.client)(request, {
        maxBytes: MAX_RESPONSE_BYTES,
        signal,
      }),
      rootSensitiveKeys
    );
  } catch (error) {
    if (deadline.signal.aborted && signal.reason === deadline.signal.reason) {
      throw new Error(
        `${provider} did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds.`,
        { cause: error }
      );
    }
    if (
      signal.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      throw error;
    }
    if (error instanceof ExecutorError && error.code === "response_too_large") {
      throw tooMuchData(provider);
    }
    if (error instanceof BillingApiError || error instanceof SyntaxError) {
      throw error;
    }
    if (error instanceof Error && error.message.startsWith(provider)) {
      throw error;
    }
    throw new Error(`${provider} could not be reached.`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
};

/** Reads one existing Autumn customer without creating or changing anything. */
export const readAutumnCustomer = (
  customerId: string,
  options: { client?: ProviderClient; signal?: AbortSignal } = {}
): Promise<unknown> =>
  call(
    "Autumn",
    {
      input: {
        body: {
          customer_id: customerId,
          expand: [
            "subscriptions.plan",
            "purchases.plan",
            "balances.feature",
            "flags.feature",
          ],
        },
        "x-api-version": "2.3.0",
      },
      operation: "autumn.customer",
    },
    options,
    new Set(["name"])
  ).catch((error: unknown) => {
    // Acquisity keys Autumn customers by billing_account.id. A 404 here is a
    // wrong id, not a missing account or an outage; say so before the model
    // writes "unavailable".
    if (error instanceof BillingApiError && error.status === 404) {
      throw new Error(
        `Autumn has no customer with id ${customerId} (HTTP 404). Autumn keys customers by billingAccount.id from read_billing_account, never the organization id. Re-check the id before recording Autumn as unavailable, empty, or unverified.`,
        { cause: error }
      );
    }
    throw error;
  });

const stripeGet = (
  request: OperationRequest,
  options: {
    client?: ProviderClient;
    rootSensitiveKeys?: ReadonlySet<string>;
    signal?: AbortSignal;
  }
): Promise<unknown> =>
  call("Stripe", request, options, options.rootSensitiveKeys);

const safeStripeGet = async (
  request: OperationRequest,
  options: {
    client?: ProviderClient;
    rootSensitiveKeys?: ReadonlySet<string>;
    signal?: AbortSignal;
  }
): Promise<{ data?: unknown; error?: string }> => {
  try {
    return { data: await stripeGet(request, options) };
  } catch (error) {
    if (
      options.signal?.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      throw error;
    }
    return {
      error:
        error instanceof Error ? error.message : "Stripe read could not run.",
    };
  }
};

const stripeIdentifier = z.string().trim().min(1).max(128);
const STRIPE_LOOKUP_ID = {
  charge: ["chargeId", /^ch_[A-Za-z0-9]+$/u],
  coupon: ["couponId", null],
  customer: ["customerId", /^cus_[A-Za-z0-9]+$/u],
  dispute: ["disputeId", /^du_[A-Za-z0-9]+$/u],
  promotion_code: ["code", null],
  refund: ["refundId", /^re_[A-Za-z0-9]+$/u],
} as const;

/**
 * One flat object, not a discriminated union: a top-level `oneOf` reaches the
 * model provider without `type: "object"`, and the call then arrives with no
 * `lookup` at all. Each lookup names the one id field it needs.
 */
export const stripeLookupSchema = z
  .object({
    chargeId: stripeIdentifier.optional(),
    code: stripeIdentifier.optional(),
    couponId: stripeIdentifier.optional(),
    customerId: stripeIdentifier.optional(),
    disputeId: stripeIdentifier.optional(),
    lookup: z
      .enum([
        "customer",
        "promotion_code",
        "coupon",
        "charge",
        "refund",
        "dispute",
      ])
      .describe(
        "customer needs customerId (cus_...); charge needs chargeId (ch_...); refund needs refundId (re_...); dispute needs disputeId (du_...); promotion_code needs code; coupon needs couponId."
      ),
    refundId: stripeIdentifier.optional(),
  })
  .superRefine((input, ctx) => {
    const [field, pattern] = STRIPE_LOOKUP_ID[input.lookup];
    const value = input[field];
    if (value === undefined) {
      ctx.addIssue({
        code: "custom",
        message: `${input.lookup} lookup needs ${field}.`,
        path: [field],
      });
    } else if (pattern && !pattern.test(value)) {
      ctx.addIssue({
        code: "custom",
        message: `${field} is not a Stripe ${input.lookup} id.`,
        path: [field],
      });
    }
  });

export type StripeLookupInput = z.infer<typeof stripeLookupSchema>;

/** Reads the bounded Stripe history needed for one known customer. */
export async function readStripeCustomerBilling(
  customerId: string,
  options: { client?: ProviderClient; signal?: AbortSignal } = {}
): Promise<Record<string, { data?: unknown; error?: string }>> {
  const lookups = {
    balanceTransactions: {
      input: { customer_id: customerId, limit: 20 },
      operation: "stripe.customers.balance_transactions",
    },
    charges: {
      input: { customer: customerId, limit: 20 },
      operation: "stripe.charges.list",
    },
    creditNotes: {
      input: { customer: customerId, limit: 20 },
      operation: "stripe.credit_notes.list",
    },
    customer: {
      input: { customer_id: customerId },
      operation: "stripe.customers.get",
    },
    invoices: {
      input: { customer: customerId, limit: 20 },
      operation: "stripe.invoices.list",
    },
    subscriptions: {
      input: { customer: customerId, limit: 20, status: "all" },
      operation: "stripe.subscriptions.list",
    },
  } as const;

  const entries = await Promise.all(
    Object.entries(lookups).map(async ([name, request]) => [
      name,
      await safeStripeGet(
        request,
        name === "customer"
          ? { ...options, rootSensitiveKeys: new Set(["name"]) }
          : options
      ),
    ])
  );
  return enforceOutputBudget("Stripe", Object.fromEntries(entries));
}

/** Reads one known Stripe charge, including its attached refund history. */
export const readStripeCharge = (
  chargeId: string,
  options: { client?: ProviderClient; signal?: AbortSignal } = {}
): Promise<unknown> =>
  stripeGet(
    {
      input: { charge_id: chargeId, "expand[]": "refunds" },
      operation: "stripe.charges.get",
    },
    options
  );

/** Reads one known Stripe refund. */
export const readStripeRefund = (
  refundId: string,
  options: { client?: ProviderClient; signal?: AbortSignal } = {}
): Promise<unknown> =>
  stripeGet(
    { input: { refund_id: refundId }, operation: "stripe.refunds.get" },
    options
  );

/** Reads one known Stripe dispute. */
export const readStripeDispute = (
  disputeId: string,
  options: { client?: ProviderClient; signal?: AbortSignal } = {}
): Promise<unknown> =>
  stripeGet(
    { input: { dispute_id: disputeId }, operation: "stripe.disputes.get" },
    options
  );

/** Finds Stripe promotion codes by the exact customer-facing code. */
export const readStripePromotionCode = (
  code: string,
  options: { client?: ProviderClient; signal?: AbortSignal } = {}
): Promise<unknown> =>
  stripeGet(
    { input: { code, limit: 20 }, operation: "stripe.promotion_codes.list" },
    options
  );

/** Reads one known Stripe coupon. */
export const readStripeCoupon = (
  couponId: string,
  options: { client?: ProviderClient; signal?: AbortSignal } = {}
): Promise<unknown> =>
  stripeGet(
    { input: { coupon_id: couponId }, operation: "stripe.coupons.get" },
    options
  );
