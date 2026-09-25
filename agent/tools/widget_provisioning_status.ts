import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import { operationPath } from "#lib/executor/bindings.js";
import {
  invokeProvider,
  type ProviderContext,
} from "#lib/executor/dispatch.js";
import { redact } from "#lib/investigation-memory/case.js";
import { PRODUCTION_READ_QUERY_ARGS } from "#lib/lookup-customer.js";
import { logOpsEvent } from "#lib/ops-log.js";
import { providerData } from "#lib/support/conversation.js";
import {
  isWidgetSupport,
  requireWidgetContext,
  type WidgetContext,
  widgetContextSchema,
} from "#lib/widget-scope.js";

const ORDER_LIMIT = 25;
// Provisioning is driven by the Acquisity Inngest function whose id is
// CAMPAIGN_FUNCTION_IDS.DOMAIN_PURCHASE_ORDER; DFY orders are first created by
// CAMPAIGN_FUNCTION_IDS.CREATE_DFY_ORDER. We return the id, not raw runs: the
// Inngest run list is not organization-scoped, so dumping it would leak other
// workspaces. The order row is the durable, org-scoped record of the run.
const PROVISIONING_FUNCTION_ID = "ai-clients.campaigns.domain-purchase-order";
const DFY_ORDER_FUNCTION_ID = "ai-clients.campaigns.create-dfy-order";
// ponytail: 30-minute no-advance heuristic for "stalled mid-poll"; tune if the
// provisioning poll interval changes and false-stalls show up.
const STALL_MS = 30 * 60_000;

// DFY orders carry their inbox quantity in dfy_config.mailboxes (domain ->
// mailbox list), not inbox_count_per_domain; Acquisity's domain purchase
// processor sums those lists. Only the aggregate leaves the database, and any
// missing, empty or non-array entry yields null rather than a partial count.
const DFY_INBOX_COUNT = `(select case when count(*) > 0 and bool_and(
        case when jsonb_typeof(mb.value) = 'array' then jsonb_array_length(mb.value) > 0 else false end)
      then sum(case when jsonb_typeof(mb.value) = 'array' then jsonb_array_length(mb.value) end)::int end
      from jsonb_each(case when dpo.order_type = 'dfy'
        and jsonb_typeof(dpo.dfy_config -> 'mailboxes') = 'object'
        then dpo.dfy_config -> 'mailboxes' else '{}'::jsonb end) mb)`;

export const widgetProvisioningInput = z.strictObject({
  orderId: z
    .uuid()
    .nullish()
    .describe(
      "Use null to list this workspace's orders first. To read domain and inbox diagnostics, use only an orderId returned by this tool; never invent an id."
    ),
});
export type WidgetProvisioningInput = z.infer<typeof widgetProvisioningInput>;

const count = z.number().int().nonnegative();
const timestamp = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)));
const orderStatus = z.enum([
  "pending_payment",
  "paid",
  "provisioning",
  "cancellation_in_progress",
  "completed",
  "requires_attention",
  "failed",
  "cancelled",
  "refunded",
]);
const runState = z.enum([
  "awaiting_payment",
  "queued",
  "running",
  "stalled",
  "completed",
  "failed",
  "cancelled",
  "cancelling",
]);

const reconciliation = z.object({
  domainsActive: count,
  domainsCharged: count,
  domainsFailed: count,
  domainsMissing: count,
  domainsProvisionedCounter: count,
  fullyProvisioned: z
    .boolean()
    .nullable()
    .describe("null when the ordered inbox quantity is unknown"),
  inboxesActive: count,
  inboxesCharged: count
    .nullable()
    .describe(
      "Ordered inbox quantity from the saved order, not proof of a charge; null when a DFY order's mailbox configuration is missing or malformed"
    ),
  inboxesConnected: count,
  inboxesMissing: count
    .nullable()
    .describe("null when the ordered inbox quantity is unknown"),
  inboxesProvisionedCounter: count,
  invisibleInboxes: z.boolean(),
});

function diagnosticText(value: string | null): string | null {
  return value === null
    ? null
    : redact(value)
        .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted URL]")
        .replace(
          /"(?:api[_-]?key|secret|password|token)"\s*:\s*"[^"\n]*"/gi,
          '"credential":"[redacted]"'
        )
        .slice(0, 500);
}
const inboxDiagnostic = z.object({
  connected: z.boolean().nullable(),
  connectionError: z.string().max(500).nullable(),
  lastRetryAt: timestamp.nullable(),
  retryCount: count.nullable(),
});
const domainDiagnostic = z.object({
  domain: z.string().max(253),
  error: z.string().max(500).nullable(),
  expectedInboxes: count.nullable(),
  inboxCount: count.nullable(),
  inboxes: z.array(inboxDiagnostic).max(5),
  inboxesTruncated: z.boolean(),
  provisionedAt: timestamp.nullable(),
  status: z.enum(["pending", "success", "partial", "failed"]),
});
const diagnostics = z.object({
  domains: z.array(domainDiagnostic).max(10),
  domainsTruncated: z.boolean(),
});

const order = z.object({
  billingAccountId: z.uuid().nullable(),
  completedAt: timestamp.nullable(),
  createdAt: timestamp,
  diagnostics: diagnostics.nullable(),
  dismissed: z.boolean(),
  error: z.string().max(500).nullable(),
  hasError: z.boolean(),
  id: z.uuid(),
  mailProvider: z.string().max(64),
  orderType: z.enum(["pre_warmed", "dfy"]),
  paidAt: timestamp.nullable(),
  providerOrderId: z.string().max(200).nullable(),
  provisioningAttempts: count,
  provisioningFunctionId: z.string().max(120),
  provisioningLastUpdated: timestamp.nullable(),
  provisioningStartedAt: timestamp.nullable(),
  reconciliation,
  runState,
  status: orderStatus,
  step: z.string().max(20),
  submissionId: z.uuid().nullable(),
  updatedAt: timestamp,
});

export const widgetProvisioningOutput = z.union([
  z.object({
    caveats: z.array(z.string()).max(6),
    observedAt: timestamp,
    orders: z.array(order).max(ORDER_LIMIT),
    source: z.literal(
      "Acquisity product database; saved order state, not a live provisioning or billing check"
    ),
    status: z.literal("ok"),
    workspace: z.string().max(500),
  }),
  z.object({
    message: z.string(),
    status: z.enum(["unavailable", "denied"]),
  }),
]);
export type WidgetProvisioningOutput = z.infer<typeof widgetProvisioningOutput>;

/** Fixed statement only; every provisioning join hangs off the authorized workspace. */
export function buildWidgetProvisioningQuery(
  context: WidgetContext,
  raw: WidgetProvisioningInput
): string {
  const scope = widgetContextSchema.parse(context);
  const input = widgetProvisioningInput.parse(raw);
  const authorization = `with authorized as (
    select o.id from organization o join member m on m.organization_id = o.id
    where o.id = '${scope.organizationId}'::uuid and m.user_id = '${scope.userId}'::uuid
      and o.deleted_at is null and m.deleted_at is null and m.role in ('owner', 'admin')
      and (o.partner_id is null or o.partner_id = '${scope.partnerId}'::uuid)
  )`;
  const domainCounts = (predicate: string) =>
    `(select count(*) from mail_domain md
      where md.organization_id = dpo.organization_id and md.order_id = dpo.id${predicate})`;
  const inboxCounts = (predicate: string) =>
    `(select count(*) from mail_inbox mi
      where mi.organization_id = dpo.organization_id and mi.order_id = dpo.id${predicate})`;
  // Project only the known diagnostic fields. Mailbox credentials, identities,
  // error_details and other arbitrary provider blobs never leave the database.
  const detail = input.orderId
    ? `case when jsonb_typeof(dpo.provisioning_log -> 'domains') = 'array' then jsonb_build_object(
      'domainsTruncated', jsonb_array_length(case when jsonb_typeof(dpo.provisioning_log -> 'domains') = 'array' then dpo.provisioning_log -> 'domains' else '[]'::jsonb end) > 10,
      'domains', coalesce((select jsonb_agg(jsonb_build_object(
        'domain', d.value ->> 'domain', 'status', d.value ->> 'status',
        'error', left(d.value ->> 'error', 2000),
        'expectedInboxes', d.value -> 'expectedInboxes', 'inboxCount', d.value -> 'inboxCount',
        'provisionedAt', d.value ->> 'provisionedAt',
        'inboxesTruncated', jsonb_array_length(case when jsonb_typeof(d.value -> 'inboxes') = 'array' then d.value -> 'inboxes' else '[]'::jsonb end) > 5,
        'inboxes', coalesce((select jsonb_agg(jsonb_build_object(
          'connected', i.value -> 'connected',
          'connectionError', left(i.value ->> 'connectionError', 2000),
          'retryCount', i.value -> 'retryCount', 'lastRetryAt', i.value ->> 'lastRetryAt'))
          from (select value from jsonb_array_elements(case when jsonb_typeof(d.value -> 'inboxes') = 'array' then d.value -> 'inboxes' else '[]'::jsonb end) limit 5) i), '[]'::jsonb)
      )) from (select value from jsonb_array_elements(case when jsonb_typeof(dpo.provisioning_log -> 'domains') = 'array' then dpo.provisioning_log -> 'domains' else '[]'::jsonb end) limit 10) d), '[]'::jsonb)
    ) else null end`
    : "null::jsonb";
  const selection = `select dpo.id, dpo.order_type as "orderType", dpo.status,
      dpo.provider as "mailProvider", dpo.provider_order_id as "providerOrderId",
      dpo.billing_account_id as "billingAccountId", dpo.submission_id as "submissionId",
      dpo.domain_count as "domainCount", dpo.inbox_count_per_domain as "inboxCountPerDomain",
      dpo.domains_provisioned as "domainsProvisioned", dpo.inboxes_provisioned as "inboxesProvisioned",
      ${DFY_INBOX_COUNT} as "dfyInboxCount",
      ${detail} as diagnostics, left(dpo.error, 2000) as error,
      dpo.dismissed, (dpo.error is not null and dpo.error <> '') as "hasError",
      coalesce(case when jsonb_typeof(dpo.provisioning_log -> 'totalAttempts') = 'number'
        and (dpo.provisioning_log ->> 'totalAttempts') ~ '^[0-9]{1,9}$'
        then (dpo.provisioning_log ->> 'totalAttempts')::int end, 0) as "provisioningAttempts",
      (dpo.provisioning_log ->> 'lastUpdated') as "provisioningLastUpdated",
      dpo.created_at as "createdAt", dpo.updated_at as "updatedAt", dpo.paid_at as "paidAt",
      dpo.provisioning_started_at as "provisioningStartedAt", dpo.completed_at as "completedAt",
      ${domainCounts("")} as "domainRows",
      ${domainCounts(" and md.status = 'active'")} as "activeDomainRows",
      ${domainCounts(" and md.status in ('failed', 'expired', 'suspended')")} as "failedDomainRows",
      ${inboxCounts("")} as "inboxRows",
      ${inboxCounts(" and mi.status = 'active'")} as "activeInboxRows",
      ${inboxCounts(" and mi.connected = true")} as "connectedInboxRows"
    from domain_purchase_order dpo join authorized a on a.id = dpo.organization_id
    ${input.orderId ? `where dpo.id = '${input.orderId}'::uuid` : ""}
    order by dpo.created_at desc, dpo.id desc limit ${ORDER_LIMIT}`;
  // One statement checks current permissions and reads orders in the same snapshot.
  return `${authorization}
    select (select count(*) = 1 from authorized) as authorized,
      current_timestamp as "observedAt",
      coalesce((select jsonb_agg(to_jsonb(r)) from (${selection}) r), '[]'::jsonb) as records`;
}

const rawOrder = z.object({
  activeDomainRows: count,
  activeInboxRows: count,
  billingAccountId: z.uuid().nullable(),
  completedAt: timestamp.nullable(),
  connectedInboxRows: count,
  createdAt: timestamp,
  dfyInboxCount: count.nullable(),
  diagnostics: diagnostics
    .extend({
      domains: z
        .array(
          domainDiagnostic.extend({
            error: z.string().max(2000).nullable(),
            inboxes: z
              .array(
                inboxDiagnostic.extend({
                  connectionError: z.string().max(2000).nullable(),
                })
              )
              .max(5),
          })
        )
        .max(10),
    })
    .nullable()
    .default(null),
  dismissed: z.boolean(),
  domainCount: count,
  domainRows: count,
  domainsProvisioned: count,
  error: z.string().max(2000).nullable().default(null),
  failedDomainRows: count,
  hasError: z.boolean(),
  id: z.uuid(),
  inboxCountPerDomain: count,
  inboxesProvisioned: count,
  inboxRows: count,
  mailProvider: z.string().max(64),
  orderType: z.enum(["pre_warmed", "dfy"]),
  paidAt: timestamp.nullable(),
  providerOrderId: z.string().max(200).nullable(),
  provisioningAttempts: count,
  provisioningLastUpdated: timestamp.nullable(),
  provisioningStartedAt: timestamp.nullable(),
  status: orderStatus,
  submissionId: z.uuid().nullable(),
  updatedAt: timestamp,
});
type RawOrder = z.infer<typeof rawOrder>;

function deriveRunState(
  row: RawOrder,
  observedAtMs: number
): z.infer<typeof runState> {
  switch (row.status) {
    case "completed":
      return "completed";
    case "failed":
    case "requires_attention":
      return "failed";
    case "cancelled":
    case "refunded":
      return "cancelled";
    case "cancellation_in_progress":
      return "cancelling";
    case "pending_payment":
      return "awaiting_payment";
    case "paid":
      return "queued";
    default: {
      const last = Date.parse(row.provisioningLastUpdated ?? row.updatedAt);
      return observedAtMs - last > STALL_MS ? "stalled" : "running";
    }
  }
}

function toOrder(row: RawOrder, observedAtMs: number): z.infer<typeof order> {
  const inboxesCharged =
    row.orderType === "dfy"
      ? row.dfyInboxCount
      : row.domainCount * row.inboxCountPerDomain;
  const domainsMissing = Math.max(0, row.domainCount - row.activeDomainRows);
  const inboxesMissing =
    inboxesCharged === null
      ? null
      : Math.max(0, inboxesCharged - row.activeInboxRows);
  return {
    billingAccountId: row.billingAccountId,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    diagnostics: row.diagnostics
      ? {
          ...row.diagnostics,
          domains: row.diagnostics.domains.map((domain) => ({
            ...domain,
            error: diagnosticText(domain.error),
            inboxes: domain.inboxes.map((inbox) => ({
              ...inbox,
              connectionError: diagnosticText(inbox.connectionError),
            })),
          })),
        }
      : null,
    dismissed: row.dismissed,
    error: diagnosticText(row.error),
    hasError: row.hasError,
    id: row.id,
    mailProvider: row.mailProvider,
    orderType: row.orderType,
    paidAt: row.paidAt,
    providerOrderId: row.providerOrderId,
    provisioningAttempts: row.provisioningAttempts,
    provisioningFunctionId:
      row.orderType === "dfy"
        ? DFY_ORDER_FUNCTION_ID
        : PROVISIONING_FUNCTION_ID,
    provisioningLastUpdated: row.provisioningLastUpdated,
    provisioningStartedAt: row.provisioningStartedAt,
    reconciliation: {
      domainsActive: row.activeDomainRows,
      domainsCharged: row.domainCount,
      domainsFailed: row.failedDomainRows,
      domainsMissing,
      domainsProvisionedCounter: row.domainsProvisioned,
      fullyProvisioned:
        inboxesMissing === null
          ? null
          : domainsMissing === 0 && inboxesMissing === 0,
      inboxesActive: row.activeInboxRows,
      inboxesCharged,
      inboxesConnected: row.connectedInboxRows,
      inboxesMissing,
      inboxesProvisionedCounter: row.inboxesProvisioned,
      invisibleInboxes: (inboxesCharged ?? 0) > 0 && row.inboxRows === 0,
    },
    runState: deriveRunState(row, observedAtMs),
    status: row.status,
    step: `${row.domainsProvisioned}/${row.domainCount}`,
    submissionId: row.submissionId,
    updatedAt: row.updatedAt,
  };
}

const CAVEATS = [
  "Saved order state is not a live provisioning or billing check; a stalled or failed status here is a lead to verify, not proof a charge was lost. paidAt is the order's own saved paid date, not a link to an invoice or charge: say the order records a paid date, call an order paid only when a billing record ties a payment to that order, and otherwise say payment for it could not be confirmed.",
  "billingAccountId is the Autumn customer link and providerOrderId the mail-provider order; check the charge and entitlement with widget_billing_summary, which covers bounded recent billing history, before saying anything about a refund.",
  "runState 'stalled' is an age heuristic, not a confirmed hung job. provisioningStartedAt records that provisioning started; incomplete steps or zero inbox rows do not mean it never started. A missing start timestamp does not prove no attempt occurred.",
  "The counters (domainsProvisionedCounter/inboxesProvisionedCounter) are the order's own tallies; domainsActive/inboxesActive count live mail rows and can differ when rows failed or were never created.",
  "submissionId and provisioningFunctionId are saved references only. Neither identifies an Inngest run. Saved domain/inbox errors and retry details are available with orderId; null diagnostics means detail was not requested or the saved domain log is missing. Truncated logs are incomplete. This tool cannot inspect live run steps without a durable owned run reference. No cross-workspace run list is returned here.",
  "An empty orders list means no matching provisioning orders in this workspace, not that a purchase failed silently or that the workspace has no other orders.",
];

/** Parse only the provider envelope and declared fields; never forward raw failure bodies. */
export function parseWidgetProvisioningEvidence(
  data: unknown,
  context: WidgetContext
): WidgetProvisioningOutput {
  const envelope = z
    .object({
      rows: z
        .array(
          z.object({
            authorized: z.boolean(),
            observedAt: timestamp,
            records: z.array(z.unknown()).max(ORDER_LIMIT),
          })
        )
        .length(1),
      success: z.literal(true),
      warnings: z.array(z.unknown()).max(0).optional(),
    })
    .parse(providerData(data));
  const [result] = envelope.rows;
  if (!result.authorized) {
    return {
      message: "Current workspace access could not be verified.",
      status: "denied",
    };
  }
  const observedAtMs = Date.parse(result.observedAt);
  const rows = z.array(rawOrder).max(ORDER_LIMIT).parse(result.records);
  return widgetProvisioningOutput.parse({
    caveats: CAVEATS,
    observedAt: result.observedAt,
    orders: rows.map((row) => toOrder(row, observedAtMs)),
    source:
      "Acquisity product database; saved order state, not a live provisioning or billing check",
    status: "ok",
    workspace: context.organizationName,
  });
}

/** An optional order selector is still constrained to the verified workspace. */
export async function readWidgetProvisioningStatus(
  ctx: ProviderContext,
  input: WidgetProvisioningInput
): Promise<WidgetProvisioningOutput> {
  const scope = requireWidgetContext(ctx.session?.auth.initiator);
  const query = buildWidgetProvisioningQuery(scope, input);
  let stage = "configuration";
  try {
    ctx.abortSignal.throwIfAborted();
    const path = operationPath("planetscale.readQuery");
    if (
      path !==
      "planetscale.org.foremanPlanetscale.planetscale_execute_read_query"
    ) {
      throw new Error("Unexpected evidence operation binding.");
    }
    stage = "transport";
    const result = await invokeProvider(
      ctx,
      path,
      { ...PRODUCTION_READ_QUERY_ARGS, query, use_replica: false },
      undefined,
      { maxBytes: 128 * 1024, timeoutMs: 50_000 }
    );
    if (!result.ok || (result.http && result.http.status !== 200)) {
      throw new Error("Evidence provider unavailable.");
    }
    stage = "response";
    return parseWidgetProvisioningEvidence(result.data, scope);
  } catch (error) {
    if (ctx.abortSignal.aborted) {
      throw error;
    }
    // Parser and provider errors may contain customer rows or credentials. Never forward them.
    logOpsEvent(
      "widget.support.provisioning_status.failed",
      {
        code: stage,
        outcome: "error",
        tool: "widget_provisioning_status",
      },
      console.warn
    );
    return {
      message:
        "Provisioning order state could not be checked. This is not an empty result; no count in it should be read as zero.",
      status: "unavailable",
    };
  }
}

const tool = defineTool({
  description:
    "Diagnose stuck domain and inbox provisioning only in this chat's verified workspace, for the 'I paid but my domains/inboxes are still provisioning' problem. Lists up to 25 recent domain-purchase orders (pre-warmed and DFY) newest first, each with: order type, status and a derived run state (awaiting_payment, queued, running, stalled, completed, failed, cancelled), the current step such as 3/6, created/paid/started/completed timestamps, the order id plus its billing-account (Autumn customer) and provider-order links and background submission id, and a reconciliation of what was charged versus what is actually provisioned (domains and inboxes charged, provisioned counters, live active rows, connected inboxes, missing counts, and an invisibleInboxes flag for charged-but-absent inboxes). Saved order state, not a live provisioning or billing check. Unavailable is not empty. Pass an orderId from these results to inspect up to 10 saved domain log entries and 5 inbox connection/retry entries per domain, with sanitized errors and explicit truncation. These are saved diagnostic observations, not live Inngest traces. No SQL, workspace or field selector is accepted.",
  execute: async (input, ctx: ToolContext) =>
    readWidgetProvisioningStatus(ctx, input),
  inputSchema: widgetProvisioningInput,
  outputSchema: widgetProvisioningOutput,
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      isWidgetSupport(ctx.session.auth.initiator) ? tool : null,
  },
});
