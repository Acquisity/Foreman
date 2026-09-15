import { z } from "zod";
import { type FinContext, finContextSchema } from "./fin-scope.js";
import { providerData } from "./support/conversation.js";

export const finEvidenceInput = z.discriminatedUnion("read", [
  z.strictObject({ after: z.uuid().optional(), read: z.literal("campaigns") }),
  z.strictObject({ campaignId: z.uuid(), read: z.literal("campaign") }),
  z.strictObject({ read: z.literal("connections") }),
]);
export type FinEvidenceInput = z.infer<typeof finEvidenceInput>;
const status = z.enum([
  "draft",
  "active",
  "paused",
  "completed",
  "archived",
  "attention_needed",
]);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)));
const campaign = z.object({
  id: z.uuid(),
  name: z.string().max(300),
  status,
  totalLeads: count.nullable(),
  updatedAt: timestamp,
});
const metric = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  emailsBounced: count.nullable(),
  emailsSent: count.nullable(),
  repliesReceived: count.nullable(),
  updatedAt: timestamp,
});
const activity = z.object({
  occurredAt: timestamp.nullable(),
  status: status.nullable(),
});
const provider = z.object({
  active: z.boolean(),
  hasSavedConnectionError: z.boolean(),
  provider: z.enum(["instantly", "emailbison"]),
  updatedAt: timestamp,
});
const evidence = z.discriminatedUnion("read", [
  z.object({
    campaigns: z.array(campaign).max(50),
    nextAfter: z.uuid().nullable(),
    read: z.literal("campaigns"),
  }),
  z.object({
    activity: z.array(activity).max(20),
    campaign,
    metrics: z.array(metric).max(30),
    read: z.literal("campaign"),
  }),
  z.object({
    connections: z.array(provider).max(10),
    read: z.literal("connections"),
  }),
]);
export const finEvidenceOutput = z.union([
  z.object({
    evidence,
    observedAt: timestamp,
    source: z.literal(
      "Acquisity product database; saved state, not a live provider check"
    ),
    status: z.literal("ok"),
    workspace: z.string().max(500),
  }),
  z.object({
    message: z.string(),
    status: z.enum(["unavailable", "not_available", "denied"]),
  }),
]);

/** Fixed statements only. UUIDs are validated even when called outside the tool schema. */
export function buildFinEvidenceQuery(
  context: FinContext,
  raw: FinEvidenceInput
): string {
  const scope = finContextSchema.parse(context);
  const input = finEvidenceInput.parse(raw);
  const authorization = `with authorized as (
    select o.id from organization o join member m on m.organization_id = o.id
    where o.id = '${scope.organizationId}'::uuid and m.user_id = '${scope.userId}'::uuid
      and o.deleted_at is null and m.deleted_at is null and m.role in ('owner', 'admin')
      and (o.partner_id is null or o.partner_id = '${scope.partnerId}'::uuid)
  )`;
  const campaignColumns = `c.id, left(c.name, 300) as name, c.status,
    c.total_leads as "totalLeads", c.updated_at as "updatedAt"`;
  const campaignFrom = `from outreach_campaign c
    join authorized a on a.id = c.organization_id
    join outreach_provider p on p.id = c.provider_id and p.organization_id = a.id
    where c.display_status = 'active'`;
  let selection: string;
  switch (input.read) {
    case "campaigns":
      selection = `select ${campaignColumns} ${campaignFrom}
        ${input.after ? `and c.id > '${input.after}'::uuid` : ""}
        order by c.id limit 51`;
      break;
    case "connections":
      selection = `select p.provider, p.is_active as active,
        (nullif(p.connection_error, '') is not null) as "hasSavedConnectionError",
        p.updated_at as "updatedAt"
        from outreach_provider p join authorized a on a.id = p.organization_id
        order by p.id limit 11`;
      break;
    case "campaign":
      selection = `select ${campaignColumns},
        coalesce((select jsonb_agg(to_jsonb(m)) from (
          select cm.date, cm.emails_sent as "emailsSent", cm.emails_bounced as "emailsBounced",
            cm.replies_received as "repliesReceived", cm.updated_at as "updatedAt"
          from outreach_campaign_metrics cm
          where cm.organization_id = c.organization_id and cm.campaign_id = c.id
          order by cm.date desc, cm.id desc limit 30
        ) m), '[]'::jsonb) as metrics,
        coalesce((select jsonb_agg(to_jsonb(s)) from (
          select ca.status, ca.occurred_at as "occurredAt" from outreach_campaign_activity ca
          where ca.organization_id = c.organization_id and ca.campaign_id = c.id
            and ca.status is not null
          order by ca.occurred_at desc nulls last, ca.id desc limit 20
        ) s), '[]'::jsonb) as activity
        ${campaignFrom} and c.id = '${input.campaignId}'::uuid limit 1`;
      break;
    default:
      throw new Error("Unsupported evidence read.");
  }
  // One statement checks current permissions and reads evidence in the same snapshot.
  return `${authorization}
    select (select count(*) = 1 from authorized) as authorized,
      current_timestamp as "observedAt",
      coalesce((select jsonb_agg(to_jsonb(r)) from (${selection}) r), '[]'::jsonb) as records`;
}

/** Parse only the actual provider envelope and explicit fields; never return raw failure bodies. */
export function parseFinEvidence(
  data: unknown,
  context: FinContext,
  input: FinEvidenceInput
): z.infer<typeof finEvidenceOutput> {
  const envelope = z
    .object({
      rows: z
        .array(
          z.object({
            authorized: z.boolean(),
            observedAt: timestamp,
            records: z.array(z.unknown()).max(51),
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
  let parsed: z.infer<typeof evidence>;
  switch (input.read) {
    case "campaigns": {
      const rows = z.array(campaign).max(51).parse(result.records);
      parsed = {
        campaigns: rows.slice(0, 50),
        nextAfter: rows.length > 50 ? rows[49].id : null,
        read: "campaigns",
      };
      break;
    }
    case "connections":
      // An overflow is unavailable: a partial list must not imply all connections were checked.
      parsed = {
        connections: z.array(provider).max(10).parse(result.records),
        read: "connections",
      };
      break;
    case "campaign": {
      if (result.records.length === 0) {
        return {
          message: "That campaign is not available in this chat's workspace.",
          status: "not_available",
        };
      }
      const [row] = z
        .array(
          campaign.extend({
            activity: z.array(activity).max(20),
            metrics: z.array(metric).max(30),
          })
        )
        .length(1)
        .parse(result.records);
      if (row.id.toLowerCase() !== input.campaignId.toLowerCase()) {
        throw new Error("Unexpected campaign response.");
      }
      parsed = {
        activity: row.activity,
        campaign: campaign.parse(row),
        metrics: row.metrics,
        read: "campaign",
      };
      break;
    }
    default:
      throw new Error("Unsupported evidence read.");
  }
  return finEvidenceOutput.parse({
    evidence: parsed,
    observedAt: result.observedAt,
    source:
      "Acquisity product database; saved state, not a live provider check",
    status: "ok",
    workspace: context.organizationName,
  });
}
