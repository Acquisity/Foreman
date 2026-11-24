import { z } from "zod";
import { diagnosticText } from "#lib/widget-diagnostic-text.js";

export const AGENT_DECISION_LIMIT = 5;
const AGENT_ACTION_LIMIT = 10;
const AGENT_FINDING_CHARS = 700;
const AGENT_TEXT_CHARS = 300;
const NAME_CHARS = 200;

const timestamp = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)));
const agentText = z.string().max(AGENT_TEXT_CHARS * 2);
const savedValue = z.string().max(64).nullable();
const actionIndex = z.number().int().nonnegative().max(1000);
const actionCount = z.number().int().nonnegative().nullable();

export const agentDecisionRow = z.object({
  actions: z
    .array(
      z.object({
        details: z.object({
          checks: z.array(z.string().max(64)).max(AGENT_ACTION_LIMIT),
          count: actionCount,
          name: z
            .string()
            .max(NAME_CHARS * 2)
            .nullable(),
          requiredPerVariant: actionCount,
          variantCount: actionCount,
        }),
        index: actionIndex,
        reason: agentText.nullable(),
        type: z.string().max(64),
      })
    )
    .max(AGENT_ACTION_LIMIT),
  approval: z
    .object({
      actionIndexes: z.array(actionIndex).max(AGENT_ACTION_LIMIT).nullable(),
      autoExecutedAt: savedValue,
      autoExecutesOnTimeout: z.boolean().nullable(),
      expiresAt: savedValue,
      requestedAt: savedValue,
      respondedAt: savedValue,
      status: savedValue,
    })
    .nullable(),
  at: timestamp,
  completed: z
    .array(z.object({ at: savedValue, index: actionIndex }))
    .max(AGENT_ACTION_LIMIT * 2),
  error: z
    .string()
    .max(AGENT_TEXT_CHARS * 2)
    .nullable(),
  finding: z
    .string()
    .max(AGENT_FINDING_CHARS * 2)
    .nullable(),
  recommended: z.array(agentText).max(AGENT_ACTION_LIMIT),
  runStatus: z.string().max(40),
  skipped: z
    .array(z.object({ index: actionIndex, reason: agentText.nullable() }))
    .max(AGENT_ACTION_LIMIT * 2),
  verdict: savedValue,
});
type AgentDecisionRow = z.infer<typeof agentDecisionRow>;

export const agentDecision = agentDecisionRow
  .omit({ actions: true, approval: true, completed: true, skipped: true })
  .extend({
    actions: z
      .array(
        z.object({
          at: savedValue,
          label: z.string().max(AGENT_TEXT_CHARS + NAME_CHARS + 100),
          reason: agentText.nullable(),
          state: z.enum([
            "taken",
            "skipped",
            "waiting_for_approval",
            "running",
            "not_run",
          ]),
          type: z.string().max(64),
        })
      )
      .max(AGENT_ACTION_LIMIT),
    approval: agentDecisionRow.shape.approval
      .unwrap()
      .omit({ actionIndexes: true })
      .nullable(),
  });

/**
 * The campaign AI Agent's last reviews, as its tab reads them (Acquisity's
 * campaign-agent-insight): live 2026-11-24 the widget said "no automatic
 * pause reason" for a campaign the agent had paused with the customer's okay.
 * `campaign` is the alias of an already authorized outreach_campaign row.
 */
export function agentDecisionsSql(campaign: string): string {
  const array = (value: string) =>
    `case when jsonb_typeof(${value}) = 'array' then ${value} else '[]'::jsonb end`;
  const flag = (key: string) =>
    `case when jsonb_typeof(da.metadata->'${key}') = 'boolean' then (da.metadata->>'${key}')::boolean end`;
  const index = (value: string) =>
    `case when jsonb_typeof(${value}) = 'number' and (${value})::text ~ '^[0-9]{1,3}$' then (${value})::text::int end`;
  const number = (value: string) =>
    `case when jsonb_typeof(${value}) = 'number' and (${value})::text ~ '^[0-9]{1,9}$' then (${value})::text::int end`;
  return `coalesce((select jsonb_agg(to_jsonb(ad) order by ad.at desc) from (
      select da.created_at as at, left(da.status, 40) as "runStatus",
        left(da.decision_details->>'status', 64) as verdict,
        left(coalesce(nullif(da.decision_details->>'reason', ''), da.decision_reason), ${AGENT_FINDING_CHARS}) as finding,
        coalesce((select jsonb_agg(left(r.value #>> '{}', ${AGENT_TEXT_CHARS}) order by r.n)
          from jsonb_array_elements(${array("da.decision_details->'recommendedActions'")}) with ordinality r(value, n)
          where r.n <= ${AGENT_ACTION_LIMIT} and jsonb_typeof(r.value) = 'string' and r.value #>> '{}' <> ''), '[]'::jsonb) as recommended,
        coalesce((select jsonb_agg(jsonb_build_object('index', a.n - 1, 'type', left(a.value->>'type', 64),
            'reason', left(a.value->'params'->>'reason', ${AGENT_TEXT_CHARS}),
            'details', jsonb_build_object(
              'count', ${number("a.value->'params'->'count'")},
              'name', left(a.value->'params'->>'name', ${NAME_CHARS}),
              'requiredPerVariant', ${number("a.value->'params'->'requiredPerVariant'")},
              'variantCount', case when jsonb_typeof(a.value->'params'->'variants') = 'array'
                then jsonb_array_length(a.value->'params'->'variants') end,
              'checks', coalesce((select jsonb_agg(left(ch.value #>> '{}', 64) order by ch.n)
                from jsonb_array_elements(${array("a.value->'params'->'checks'")}) with ordinality ch(value, n)
                where ch.n <= ${AGENT_ACTION_LIMIT} and jsonb_typeof(ch.value) = 'string'), '[]'::jsonb))) order by a.n)
          from jsonb_array_elements(${array("da.decision_details->'actions'")}) with ordinality a(value, n)
          where a.n <= ${AGENT_ACTION_LIMIT} and jsonb_typeof(a.value->'type') = 'string'), '[]'::jsonb) as actions,
        coalesce((select jsonb_agg(jsonb_build_object('index', ${index("d.value->'index'")}, 'at', left(d.value->>'completedAt', 64)))
          from jsonb_array_elements(${array("da.metadata->'completedActions'")}) d(value)
          where ${index("d.value->'index'")} < ${AGENT_ACTION_LIMIT} and jsonb_typeof(d.value->'completedAt') = 'string'), '[]'::jsonb) as completed,
        coalesce((select jsonb_agg(jsonb_build_object('index', ${index("k.value->'index'")}, 'reason', left(k.value->>'reason', ${AGENT_TEXT_CHARS})))
          from jsonb_array_elements(${array("da.metadata->'skippedActions'")}) k(value)
          where ${index("k.value->'index'")} < ${AGENT_ACTION_LIMIT}), '[]'::jsonb) as skipped,
        case when da.metadata ? 'approvalStatus' or da.metadata ? 'approvalRequestedAt' then jsonb_build_object(
          'status', left(da.metadata->>'approvalStatus', 64),
          'requestedAt', left(da.metadata->>'approvalRequestedAt', 64),
          'expiresAt', left(da.metadata->>'approvalExpiresAt', 64),
          'respondedAt', left(da.metadata->>'respondedAt', 64),
          'autoExecutedAt', left(da.metadata->>'approvalAutoExecutedAt', 64),
          'autoExecutesOnTimeout', ${flag("approvalAutoExecutesOnTimeout")},
          'actionIndexes', (select jsonb_agg(${index("i.value")})
            from jsonb_array_elements(${array("da.metadata->'approvalActionIndexes'")}) i(value)
            where ${index("i.value")} < ${AGENT_ACTION_LIMIT})) end as approval,
        left(da.metadata->>'errorMessage', ${AGENT_TEXT_CHARS}) as error
      from outreach_campaign_decision_analytics da
      where da.organization_id = ${campaign}.organization_id and da.campaign_id = ${campaign}.id
      order by da.created_at desc limit ${AGENT_DECISION_LIMIT}
    ) ad), '[]'::jsonb)`;
}

/** The action's line on the AI Agent tab (Acquisity's format-action `formatActionWithParams`). */
function actionLabel({
  details,
  reason,
  type,
}: AgentDecisionRow["actions"][number]): string {
  const count = details.count ? details.count.toLocaleString("en-US") : null;
  switch (type) {
    case "DISABLE_VARIANTS":
      return details.variantCount
        ? `Disable ${details.variantCount} underperforming variant${details.variantCount === 1 ? "" : "s"}`
        : "Disable underperforming variants";
    case "ADD_LEADS_TO_PRESENT_CAMPAIGN":
      return count ? `Add ${count} leads to campaign` : "Add leads to campaign";
    case "PAUSE_CAMPAIGN":
      return reason ? `Pause campaign: ${reason}` : "Pause campaign";
    case "START_NEW_CAMPAIGN": {
      const leads = count ? ` (${count} leads)` : "";
      return details.name
        ? `Start "${details.name}" campaign${leads}`
        : `Start new campaign${leads}`;
    }
    case "FLAG_DELIVERABILITY":
      return details.checks.length
        ? `Flag deliverability: ${details.checks.join(", ")}`
        : "Flag deliverability issues";
    case "WAIT_FOR_VOLUME":
      return details.requiredPerVariant
        ? `Wait for volume (${details.requiredPerVariant} per variant)`
        : "Wait for sufficient volume";
    default:
      return type.replaceAll("_", " ");
  }
}

/**
 * Each action's state as the AI Agent tab shows it (Acquisity's
 * campaign-agent-insight `toInsight`): taken or skipped once recorded, waiting
 * while the run's approval is open, running while the run is, else not run.
 */
export function readAgentDecision(
  row: AgentDecisionRow
): z.infer<typeof agentDecision> {
  const completedAt = new Map(
    row.completed.map((done) => [done.index, done.at])
  );
  const skipped = new Map(row.skipped.map((skip) => [skip.index, skip.reason]));
  const approvalStatus = row.approval?.status ?? null;
  const awaiting =
    row.runStatus === "awaiting_approval" &&
    (approvalStatus === null || approvalStatus === "awaiting_approval");
  const approvalIndexes = row.approval?.actionIndexes
    ? new Set(row.approval.actionIndexes)
    : null;
  const openState = (index: number) => {
    if (awaiting && (!approvalIndexes || approvalIndexes.has(index))) {
      return "waiting_for_approval" as const;
    }
    return awaiting || row.runStatus === "pending"
      ? ("running" as const)
      : ("not_run" as const);
  };
  return {
    actions: row.actions.map((action) => {
      const base = {
        label: actionLabel(action),
        reason: action.reason,
        type: action.type,
      };
      if (completedAt.has(action.index)) {
        return {
          ...base,
          at: completedAt.get(action.index) ?? null,
          state: "taken",
        };
      }
      if (skipped.has(action.index)) {
        return {
          ...base,
          at: null,
          reason: skipped.get(action.index) ?? action.reason,
          state: "skipped",
        };
      }
      return { ...base, at: null, state: openState(action.index) };
    }),
    approval: row.approval && {
      autoExecutedAt: row.approval.autoExecutedAt,
      autoExecutesOnTimeout: row.approval.autoExecutesOnTimeout,
      expiresAt: row.approval.expiresAt,
      requestedAt: row.approval.requestedAt,
      respondedAt: row.approval.respondedAt,
      status: row.approval.status,
    },
    at: row.at,
    error: diagnosticText(row.error, AGENT_TEXT_CHARS),
    finding: row.finding,
    recommended: row.recommended,
    runStatus: row.runStatus,
    verdict: row.verdict,
  };
}
