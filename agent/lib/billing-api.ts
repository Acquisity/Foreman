const AUTUMN_API_URL = "https://api.useautumn.com/v1";
const STRIPE_API_URL = "https://api.stripe.com/v1";
const MAX_RESPONSE_BYTES = 256 * 1024;
const SENSITIVE_RESPONSE_KEYS = new Set([
  "address",
  "billing_details",
  "client_secret",
  "default_payment_method",
  "default_source",
  "payment_method",
  "phone",
  "receipt_email",
  "shipping",
  "sources",
]);

type Fetcher = typeof fetch;

const sanitize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sanitize);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_RESPONSE_KEYS.has(key))
      .map(([key, entry]) => [key, sanitize(entry)])
  );
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
  response: Response
): Promise<unknown> => {
  if (!response.ok) {
    throw new BillingApiError(provider, response.status);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error(
      `${provider} returned too much data. Narrow the lookup before concluding.`
    );
  }
  try {
    return sanitize(JSON.parse(text) as unknown);
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
  fetchImpl: Fetcher
): Promise<unknown> => {
  try {
    return await parseResponse(provider, await fetchImpl(url, init));
  } catch (error) {
    if (error instanceof BillingApiError || error instanceof SyntaxError) {
      throw error;
    }
    if (error instanceof Error && error.message.startsWith(provider)) {
      throw error;
    }
    throw new Error(`${provider} could not be reached.`, { cause: error });
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
    options.fetch ?? fetch
  );

const stripeGet = (
  token: string,
  path: string,
  options: { fetch?: Fetcher; signal?: AbortSignal }
): Promise<unknown> =>
  call(
    "Stripe",
    `${STRIPE_API_URL}${path}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      method: "GET",
      signal: options.signal,
    },
    options.fetch ?? fetch
  );

const safeStripeGet = async (
  token: string,
  path: string,
  options: { fetch?: Fetcher; signal?: AbortSignal }
): Promise<{ data?: unknown; error?: string }> => {
  try {
    return { data: await stripeGet(token, path, options) };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "Stripe read could not run.",
    };
  }
};

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
      await safeStripeGet(token, path, options),
    ])
  );
  return Object.fromEntries(entries);
}

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
