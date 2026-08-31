import { z } from "zod";

const AUTUMN_API_URL = "https://api.useautumn.com/v1";
const STRIPE_API_URL = "https://api.stripe.com/v1";
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

type Fetcher = typeof fetch;

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

const readBoundedText = async (
  provider: "Autumn" | "Stripe",
  response: Response
): Promise<string> => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw tooMuchData(provider);
  }
  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  // biome-ignore lint/suspicious/noUnnecessaryConditions: the stream's done flag terminates the loop.
  while (true) {
    // biome-ignore lint/performance/noAwaitInLoops: stream chunks must be read sequentially to enforce the byte cap.
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    totalBytes += value.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooMuchData(provider);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
};

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

const parseResponse = async (
  provider: "Autumn" | "Stripe",
  response: Response,
  rootSensitiveKeys: ReadonlySet<string>
): Promise<unknown> => {
  if (!response.ok) {
    throw new BillingApiError(provider, response.status);
  }
  const text = await readBoundedText(provider, response);
  try {
    return sanitize(JSON.parse(text) as unknown, rootSensitiveKeys);
  } catch (error) {
    throw new Error(`${provider} returned an unreadable response.`, {
      cause: error,
    });
  }
};

const call = async (
  provider: "Autumn" | "Stripe",
  url: string,
  init: RequestInit,
  fetchImpl: Fetcher,
  rootSensitiveKeys: ReadonlySet<string> = new Set()
): Promise<unknown> => {
  // The caller's signal stays on `init` so cancellation is still recognized
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
  const signal = init.signal
    ? AbortSignal.any([init.signal, deadline.signal])
    : deadline.signal;
  try {
    return await parseResponse(
      provider,
      await fetchImpl(url, { ...init, signal }),
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
  token: string,
  customerId: string,
  options: { fetch?: Fetcher; signal?: AbortSignal } = {}
): Promise<unknown> =>
  call(
    "Autumn",
    `${AUTUMN_API_URL}/customers.get`,
    {
      body: JSON.stringify({
        customer_id: customerId,
        expand: [
          "subscriptions.plan",
          "purchases.plan",
          "balances.feature",
          "flags.feature",
        ],
      }),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-api-version": "2.3.0",
      },
      method: "POST",
      signal: options.signal,
    },
    options.fetch ?? fetch,
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
  token: string,
  path: string,
  options: {
    fetch?: Fetcher;
    rootSensitiveKeys?: ReadonlySet<string>;
    signal?: AbortSignal;
  }
): Promise<unknown> =>
  call(
    "Stripe",
    `${STRIPE_API_URL}${path}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      method: "GET",
      signal: options.signal,
    },
    options.fetch ?? fetch,
    options.rootSensitiveKeys
  );

const safeStripeGet = async (
  token: string,
  path: string,
  options: {
    fetch?: Fetcher;
    rootSensitiveKeys?: ReadonlySet<string>;
    signal?: AbortSignal;
  }
): Promise<{ data?: unknown; error?: string }> => {
  try {
    return { data: await stripeGet(token, path, options) };
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
  token: string,
  customerId: string,
  options: { fetch?: Fetcher; signal?: AbortSignal } = {}
): Promise<Record<string, { data?: unknown; error?: string }>> {
  const encoded = encodeURIComponent(customerId);
  const lookups = {
    balanceTransactions: `/customers/${encoded}/balance_transactions?limit=20`,
    charges: `/charges?customer=${encoded}&limit=20`,
    creditNotes: `/credit_notes?customer=${encoded}&limit=20`,
    customer: `/customers/${encoded}`,
    invoices: `/invoices?customer=${encoded}&limit=20`,
    subscriptions: `/subscriptions?customer=${encoded}&status=all&limit=20`,
  } as const;

  const entries = await Promise.all(
    Object.entries(lookups).map(async ([name, path]) => [
      name,
      await safeStripeGet(
        token,
        path,
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
  token: string,
  chargeId: string,
  options: { fetch?: Fetcher; signal?: AbortSignal } = {}
): Promise<unknown> =>
  stripeGet(
    token,
    `/charges/${encodeURIComponent(chargeId)}?expand[]=refunds`,
    options
  );

/** Reads one known Stripe refund. */
export const readStripeRefund = (
  token: string,
  refundId: string,
  options: { fetch?: Fetcher; signal?: AbortSignal } = {}
): Promise<unknown> =>
  stripeGet(token, `/refunds/${encodeURIComponent(refundId)}`, options);

/** Reads one known Stripe dispute. */
export const readStripeDispute = (
  token: string,
  disputeId: string,
  options: { fetch?: Fetcher; signal?: AbortSignal } = {}
): Promise<unknown> =>
  stripeGet(token, `/disputes/${encodeURIComponent(disputeId)}`, options);

/** Finds Stripe promotion codes by the exact customer-facing code. */
export const readStripePromotionCode = (
  token: string,
  code: string,
  options: { fetch?: Fetcher; signal?: AbortSignal } = {}
): Promise<unknown> =>
  stripeGet(
    token,
    `/promotion_codes?code=${encodeURIComponent(code)}&limit=20`,
    options
  );

/** Reads one known Stripe coupon. */
export const readStripeCoupon = (
  token: string,
  couponId: string,
  options: { fetch?: Fetcher; signal?: AbortSignal } = {}
): Promise<unknown> =>
  stripeGet(token, `/coupons/${encodeURIComponent(couponId)}`, options);
