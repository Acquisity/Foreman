/**
 * Every tool a root or critic replay session can see, and whether a replay
 * may call it (ENG-16049). The replay hook cancels the turn when the model
 * asks for a tool that isn't `allow`, so a new tool can't slip through: the
 * tool-policy test fails until it's listed here. `allow` tools are local,
 * model-only, answered by the simulated store or the pinned sandbox, or fail
 * closed at the Executor or egress walls; the reason says which. `own` marks
 * a tool whose result is the replay's own work, a draft, a decision or a store
 * answer it wrote, so the leakage scan skips it.
 */
interface Policy {
  generated: boolean;
  mode: "allow" | "deny";
  reason: string;
  sandbox: boolean;
}

const allow = (reason: string, sandbox = false): Policy => ({
  generated: false,
  mode: "allow",
  reason,
  sandbox,
});
const own = (reason: string): Policy => ({
  generated: true,
  mode: "allow",
  reason,
  sandbox: false,
});
const deny = (reason: string): Policy => ({
  generated: false,
  mode: "deny",
  reason,
  sandbox: false,
});

const MODEL = "model call only";
const STORE = "answered by the simulated Linear store";
const SANDBOX = "runs in the clean, network-denied replay sandbox";
const inSandbox = () => allow(SANDBOX, true);
const CLOSED = "production evidence; fails closed with no data";
const WRITE = "writes outside the replay";
const OFF_LANE = "not part of triage";
const CONNECTION =
  "denied at the Executor connection's approval and recorded as an evidence miss; the replay Linear tools answer instead";

export const REPLAY_TOOL_POLICY: Readonly<Record<string, Policy>> = {
  bash: inSandbox(),
  check_reply: own(MODEL),
  checkout_branch: deny(WRITE),
  checkout_commit: inSandbox(),
  classify_ask: own(MODEL),
  clear_user_preferences: deny(WRITE),
  comment_triage_replay_issue: own(STORE),
  correct_investigation_case: deny(WRITE),
  create_triage_replay_issue: own(STORE),
  critic: allow("the critic subagent, under the same replay boundary"),
  decide_billing: own(MODEL),
  decide_prior_work: own(MODEL),
  decide_triage: own(MODEL),
  describe_table: allow(CLOSED),
  executor__execute: allow(CONNECTION),
  executor__skills: allow(CONNECTION),
  find_function_runs: allow(CLOSED),
  find_help_article: allow("public help center; blocked at the egress wall"),
  find_related_issues: allow(STORE),
  get_user_preferences: deny(OFF_LANE),
  glob: inSandbox(),
  grep: inSandbox(),
  list_gateway_models: deny(OFF_LANE),
  list_instantly_subworkspaces: allow(CLOSED),
  list_triage_replay_catalog: own(STORE),
  lookup_customer: allow(CLOSED),
  no_reply: allow("ends the turn without a message"),
  planetscale_execute_read_query: allow(CLOSED),
  prepare_repository: inSandbox(),
  push_branch: deny(WRITE),
  read_agent_models: deny(OFF_LANE),
  read_ai_sdr_weekly_report: deny(OFF_LANE),
  read_autumn_billing: allow(CLOSED),
  read_billing_account: allow(CLOSED),
  read_file: inSandbox(),
  read_foreman_costs: deny(OFF_LANE),
  read_image: inSandbox(),
  read_instantly_subworkspace: allow(CLOSED),
  read_repository_knowledge: deny(
    "repository knowledge is newer than the case"
  ),
  read_sentry_issue: allow(CLOSED),
  read_stripe_billing: allow(CLOSED),
  read_triage_replay_document: own(STORE),
  read_triage_replay_issue: own(STORE),
  rebuild_warm_snapshot: deny(WRITE),
  record_investigation_case: own(STORE),
  reply_to_requester: own(STORE),
  route_ticket: own(STORE),
  save_investigation_document: own(STORE),
  save_user_preferences: deny(WRITE),
  search_investigation_memory: allow("memory is off in a replay process"),
  set_agent_models: deny(WRITE),
  sleep: allow("waits only"),
  support_investigation: deny(OFF_LANE),
  support_provider: allow("refused at the Executor dispatch wall"),
  update_repository_knowledge: deny(WRITE),
  vision: allow("the vision subagent; model call only"),
  web_fetch: deny("the open web is newer than the case"),
  web_search: deny("the open web is newer than the case"),
  write_file: inSandbox(),
};

/** eve's own task and catalog tools, which run nothing outside the session. */
const EVE_BUILTINS = /^eve__(task_wait|task_cancel|search|tool|skill)$/u;

/** Whether a replay session may call this tool. Unknown names are denied. */
export function replayMayCall(toolName: string): boolean {
  if (EVE_BUILTINS.test(toolName)) {
    return true;
  }
  return REPLAY_TOOL_POLICY[toolName]?.mode === "allow";
}

export const replayOutputIsGenerated = (toolName: string): boolean =>
  REPLAY_TOOL_POLICY[toolName]?.generated === true;

export const replayOutputIsSandbox = (toolName: string): boolean =>
  REPLAY_TOOL_POLICY[toolName]?.sandbox === true;

export const REPLAY_SANDBOX_TOOLS: ReadonlySet<string> = new Set(
  Object.keys(REPLAY_TOOL_POLICY).filter(replayOutputIsSandbox)
);
