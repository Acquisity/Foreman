import type {
  DatabaseFacts,
  EvidenceSources,
  InvoiceFacts,
  StripeFacts,
} from "./dispute-evidence.js";
import {
  type Fact,
  type Flag,
  ms,
  type RowList,
  type Source,
  str,
  UUID,
} from "./dispute-evidence-shared.js";
import { matchChargeInvoice, pageCoversCharge } from "./stripe-dispute-read.js";

const ERRORING = /error|fail/iu;
const WITHDRAWN = /cancel|reject/iu;
const PROOF_LIMIT = 20;
const unknown = (reason: string): Flag => ({
  because: [],
  unknown: reason,
  value: null,
});

/** A returned row proves a positive; only complete inputs prove a negative. */
const flag = (because: Fact[], missing: string | null): Flag => {
  if (because.length) {
    return {
      because: because.slice(0, PROOF_LIMIT),
      proofTruncated: because.length > PROOF_LIMIT,
      value: true,
    };
  }
  return missing ? unknown(missing) : { because: [], value: false };
};
const incomplete = (list: RowList | null | undefined) =>
  !list || list.truncated;
const before = (value: unknown, chargeMs: number) => {
  const at = ms(value);
  return at !== null && at < chargeMs;
};
const invoiceOf = (stripe: StripeFacts) => stripe.chargeInvoice.invoice;

const refundedInFull = (stripe: StripeFacts): Flag => {
  const { amount, amountRefunded, refunds } = stripe.charge;
  if (amount === null) {
    return unknown("Stripe reported no charge amount.");
  }
  const because = refunds.slice(0, PROOF_LIMIT).map((refund) => ({
    date: refund.created,
    detail: `Refund ${refund.id ?? ""} of ${refund.amount ?? "?"} (${refund.status ?? "unknown status"}).`,
    source: "stripe.charges.refunds",
  }));
  return {
    because,
    proofTruncated: refunds.length > PROOF_LIMIT,
    value: amount > 0 && amountRefunded >= amount,
  };
};

/** A catalog price can be shared by unrelated purchases; it is never an item key. */
const billedKeys = (invoice: InvoiceFacts): Set<string> =>
  new Set(
    invoice.lines.flatMap((line) => {
      const item =
        line.subscriptionItem ?? line.subscription ?? invoice.subscription;
      return item && line.periodStart && line.periodEnd
        ? [`${item}|${line.periodStart}|${line.periodEnd}`]
        : [];
    })
  );
const duplicate = (stripe: StripeFacts): Flag => {
  const { charges, invoices } = stripe;
  if (!(charges && invoices)) {
    return unknown(
      "The customer's Stripe charges or invoices could not be read."
    );
  }
  const disputed = invoiceOf(stripe);
  if (!disputed) {
    return unknown("The disputed charge's invoice could not be identified.");
  }
  const keys = billedKeys(disputed);
  if (!keys.size) {
    return unknown(
      "The disputed invoice has no known subscription item and complete billed period."
    );
  }
  let missing =
    charges.truncated || invoices.truncated || disputed.linesTruncated;
  const because: Fact[] = [];
  for (const other of charges.rows) {
    if (
      other.id === stripe.charge.id ||
      other.status !== "succeeded" ||
      other.amount === null ||
      other.amountRefunded >= other.amount
    ) {
      continue;
    }
    const { invoice } = matchChargeInvoice(
      other,
      invoices.rows,
      pageCoversCharge(invoices.rows, invoices.truncated, other.created)
    );
    if (!invoice) {
      missing = true;
      continue;
    }
    if (invoice.id === disputed.id) {
      continue;
    }
    const otherKeys = billedKeys(invoice);
    missing ||= invoice.linesTruncated || !otherKeys.size;
    if ([...otherKeys].some((key) => keys.has(key))) {
      because.push({
        date: other.created,
        detail: `Charge ${other.id} of ${other.amount} on invoice ${invoice.id} bills the same subscription item for the same period and is not refunded.`,
        source: "stripe.charges",
      });
    }
  }
  return flag(
    because,
    missing ? "Charge, invoice, or line evidence is incomplete." : null
  );
};

const outage = (database: DatabaseFacts, chargeMs: number) => {
  const { domains, inboxes } = database;
  const stoppedDomains = (domains?.rows ?? []).flatMap((row) => {
    const status = str(row.status)?.toLowerCase();
    const date = [row.expires_at, row.updated_at].find((value) =>
      before(value, chargeMs)
    );
    return (status === "expired" || status === "suspended") && date
      ? [
          {
            date: str(date),
            detail: `Domain ${str(row.domain)} was ${status}.`,
            source: "database.mail_domain",
          },
        ]
      : [];
  });
  const stoppedInboxes = (inboxes?.rows ?? []).flatMap((row) =>
    (ERRORING.test(str(row.status) ?? "") || str(row.connection_error)) &&
    before(row.last_retry_at, chargeMs)
      ? [
          {
            date: str(row.last_retry_at),
            detail: `Inbox ${str(row.email)} was failing (${str(row.status)}).`,
            source: "database.mail_inbox",
          },
        ]
      : []
  );
  const full = (list: RowList | null | undefined, affected: Fact[]) =>
    !incomplete(list) &&
    affected.length > 0 &&
    affected.length === list?.rows.length;
  const because = [
    ...(full(domains, stoppedDomains) ? stoppedDomains : []),
    ...(full(inboxes, stoppedInboxes) ? stoppedInboxes : []),
  ];
  const partial = (list: RowList | null | undefined, affected: Fact[]) =>
    affected.length > 0 && affected.length < (list?.rows.length ?? 0);
  const partialProof = [
    ...(partial(domains, stoppedDomains) ? stoppedDomains : []),
    ...(partial(inboxes, stoppedInboxes) ? stoppedInboxes : []),
  ];
  return {
    because,
    partial: {
      ...flag(
        partialProof,
        incomplete(domains) || incomplete(inboxes)
          ? "Delivery counts are incomplete."
          : null
      ),
      counts: {
        domains: {
          affected: stoppedDomains.length,
          total: domains?.rows.length ?? null,
          truncated: domains?.truncated ?? true,
        },
        inboxes: {
          affected: stoppedInboxes.length,
          total: inboxes?.rows.length ?? null,
          truncated: inboxes?.truncated ?? true,
        },
      },
    },
  };
};

const stoppedInDatabase = (
  database: DatabaseFacts,
  chargeMs: number
): Fact[] => {
  const { because } = outage(database, chargeMs);
  for (const row of database.deletionRequests?.rows ?? []) {
    if (
      !WITHDRAWN.test(str(row.status) ?? "") &&
      before(row.created_at, chargeMs)
    ) {
      because.push({
        date: str(row.created_at),
        detail: `Workspace deletion was requested (${str(row.status)}).`,
        source: "database.workspace_deletion_request",
      });
    }
  }
  return because;
};

const deliveryStoppedBeforeCharge = (
  stripe: StripeFacts,
  database: Source<DatabaseFacts>,
  chargeMs: number
): Flag => {
  const because: Fact[] = [];
  const invoice = invoiceOf(stripe);
  const subscriptionIds = [
    ...new Set(
      [
        invoice?.subscription,
        ...(invoice?.lines.map((line) => line.subscription) ?? []),
      ].filter((id): id is string => Boolean(id))
    ),
  ];
  const [subscription] = subscriptionIds;
  const canceled =
    subscriptionIds.length === 1
      ? stripe.subscriptions?.rows.find(
          (row) => row.id === subscription && before(row.canceledAt, chargeMs)
        )
      : undefined;
  if (canceled) {
    because.push({
      date: canceled.canceledAt,
      detail: `Subscription ${canceled.id} was canceled or set to cancel before the charge.`,
      source: "stripe.subscriptions",
    });
  }
  const { facts } = database;
  if (facts?.provisioned) {
    because.push(...stoppedInDatabase(facts, chargeMs));
  }
  const missing =
    !facts?.provisioned ||
    [facts.domains, facts.inboxes, facts.deletionRequests].some(incomplete) ||
    !invoice ||
    subscriptionIds.length > 1 ||
    incomplete(stripe.subscriptions);
  return flag(
    because,
    missing ? "Delivery or subscription evidence is incomplete." : null
  );
};

const usedAfterCharge = (database: DatabaseFacts, chargeMs: number): Flag => {
  const after = (value: unknown) => {
    const at = ms(value);
    return at !== null && at > chargeMs;
  };
  const because: Fact[] = [];
  const session = database.sessions?.rows.find(
    (row) =>
      row.active_organization_id === database.provisioned?.organizationId &&
      after(row.created_at)
  );
  if (session) {
    because.push({
      date: str(session.created_at),
      detail: `A session in the provisioned workspace was created from ${str(session.ip_address) ?? "an unknown address"}.`,
      source: "database.session",
    });
  }
  const chargeDay = new Date(chargeMs).toISOString().slice(0, 10);
  const sends = (database.campaignMetrics?.rows ?? []).filter(
    (row) =>
      (str(row.date)?.slice(0, 10) ?? "") > chargeDay &&
      Number(row.emails_sent) > 0
  );
  if (sends.length) {
    because.push({
      date: str(sends[0]?.date),
      detail: `${sends.reduce((sum, row) => sum + Number(row.emails_sent), 0)} emails sent across ${sends.length} campaign days after the charge.`,
      source: "database.outreach_campaign_metrics",
    });
  }
  for (const [table, column, label] of [
    ["domains", "provisioned_at", "Domain"],
    ["inboxes", "created_at", "Inbox"],
  ] as const) {
    const row = database[table]?.rows.find((entry) => after(entry[column]));
    if (row) {
      because.push({
        date: str(row[column]),
        detail: `${label} ${str(row.domain) ?? str(row.email)} provisioned after the charge.`,
        source: `database.${table === "domains" ? "mail_domain" : "mail_inbox"}`,
      });
    }
  }
  const missing = [
    database.sessions,
    database.campaignMetrics,
    database.domains,
    database.inboxes,
  ].some(incomplete);
  return flag(
    because,
    missing ? "Workspace use evidence is incomplete." : null
  );
};

/** Partial sources can prove facts; missing or cut inputs cannot prove negatives. */
export const verdictFacts = (sources: EvidenceSources) => {
  const stripe = sources.stripe.facts;
  const database = sources.database.facts;
  if (!stripe) {
    const none = unknown("The Stripe read failed.");
    return {
      chargeDate: null,
      deliveryStoppedBeforeCharge: none,
      duplicate: none,
      partialOutageBeforeCharge: none,
      refundedInFull: none,
      tiedToWorkspace: none,
      usedAfterCharge: none,
    };
  }
  const chargeDate = stripe.charge.created;
  const chargeMs = chargeDate ? Date.parse(chargeDate) : Number.NaN;
  const dated = Number.isFinite(chargeMs);
  const autumnId = stripe.customer?.autumnId;
  let tiedToWorkspace: Flag;
  let used: Flag;
  if (!stripe.customer) {
    tiedToWorkspace = stripe.unavailable.length
      ? unknown("The Stripe customer could not be read.")
      : {
          because: [
            {
              date: chargeDate,
              detail: "The charge has no Stripe customer.",
              source: "stripe.charges",
            },
          ],
          value: false,
        };
    used = unknown("No workspace is tied to the charge.");
  } else if (!(autumnId && UUID.test(autumnId))) {
    tiedToWorkspace = unknown(
      "The Stripe customer carries no valid billing account id."
    );
    used = unknown("No workspace is tied to the charge.");
  } else if (database?.provisioned) {
    const { provisioned } = database;
    tiedToWorkspace = {
      because: [
        {
          date: null,
          detail: `Workspace ${provisioned.name ?? provisioned.organizationId} is the billing account's only live workspace.`,
          source: "database.organization",
        },
      ],
      value: true,
    };
    used = dated
      ? usedAfterCharge(database, chargeMs)
      : unknown("Stripe reported no charge date.");
  } else if (
    database &&
    !incomplete(database.organizations) &&
    !incomplete(database.orders) &&
    database.organizations.rows.every((row) => row.deleted_at)
  ) {
    tiedToWorkspace = {
      because: [
        {
          date: null,
          detail:
            "No live workspace uses the Stripe customer's billing account.",
          source: "database.organization",
        },
      ],
      value: false,
    };
    used = unknown("No workspace is tied to the charge.");
  } else {
    tiedToWorkspace = unknown(
      "The charge's workspace could not be established from complete account evidence."
    );
    used = unknown("The charge's workspace could not be established.");
  }
  return {
    chargeDate,
    deliveryStoppedBeforeCharge: dated
      ? deliveryStoppedBeforeCharge(stripe, sources.database, chargeMs)
      : unknown("Stripe reported no charge date."),
    duplicate: duplicate(stripe),
    partialOutageBeforeCharge:
      dated && database?.provisioned
        ? outage(database, chargeMs).partial
        : unknown("The workspace or charge date could not be established."),
    refundedInFull: refundedInFull(stripe),
    tiedToWorkspace,
    usedAfterCharge: used,
  };
};
