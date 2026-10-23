/**
 * Every tool a root or critic replay session can see, and whether a replay
 * may call it (ENG-16049). The replay hook cancels the turn when the model
 * asks for a tool that isn't `allow`, so a new tool can't slip through: the
 * tool-policy test fails until it's listed here. `allow` tools are local,
 * model-only, answered by the simulated store or the pinned sandbox, or fail
 * closed at the Executor or egress walls; the reason says which.
 */
interface Policy {
  mode: "allow" | "deny";
  reason: string;
}

const allow = (reason: string): Policy => ({ mode: "allow", reason });
const deny = (reason: string): Policy => ({ mode: "deny", reason });

const MODEL = "model call only";
const STORE = "answered by the simulated Linear store";
const SANDBOX = "runs in the clean, network-denied replay sandbox";
const CLOSED = "production evidence; fails closed with no data";
const WRITE = "writes outside the replay";
const OFF_LANE = "not part of triage";
const CONNECTION =
  "denied at the Executor connection's approval and recorded as an evidence miss; the replay Linear tools answer instead";

export const REPLAY_TOOL_POLICY: Readonly<Record<string, Policy>> = {
  bash: allow(SANDBOX),
  check_reply: allow(MODEL),
  checkout_branch: deny(WRITE),
  checkout_commit: allow(SANDBOX),
  classify_ask: allow(MODEL),
  clear_user_preferences: deny(WRITE),
  comment_triage_replay_issue: allow(STORE),
  correct_investigation_case: deny(WRITE),
  create_triage_replay_issue: allow(STORE),
  critic: allow("the critic subagent, under the same replay boundary"),
  decide_billing: allow(MODEL),
  decide_prior_work: allow(MODEL),
  decide_triage: allow(MODEL),
  describe_table: allow(CLOSED),
  executor__execute: allow(CONNECTION),
  executor__skills: allow(CONNECTION),
  find_function_runs: allow(CLOSED),
  find_help_article: allow("public help center; blocked at the egress wall"),
  find_related_issues: allow(STORE),
  get_user_preferences: deny(OFF_LANE),
  glob: allow(SANDBOX),
  grep: allow(SANDBOX),
  list_gateway_models: deny(OFF_LANE),
  list_instantly_subworkspaces: allow(CLOSED),
  list_triage_replay_catalog: allow(STORE),
  lookup_customer: allow(CLOSED),
  no_reply: allow("ends the turn without a message"),
  planetscale_execute_read_query: allow(CLOSED),
  prepare_repository: allow(SANDBOX),
  push_branch: deny(WRITE),
  read_agent_models: deny(OFF_LANE),
  read_ai_sdr_weekly_report: deny(OFF_LANE),
  read_autumn_billing: allow(CLOSED),
  read_billing_account: allow(CLOSED),
  read_file: allow(SANDBOX),
  read_foreman_costs: deny(OFF_LANE),
  read_image: allow(SANDBOX),
  read_instantly_subworkspace: allow(CLOSED),
  read_repository_knowledge: deny(
    "repository knowledge is newer than the case"
  ),
  read_sentry_issue: allow(CLOSED),
  read_stripe_billing: allow(CLOSED),
  read_triage_replay_document: allow(STORE),
  read_triage_replay_issue: allow(STORE),
  rebuild_warm_snapshot: deny(WRITE),
  record_investigation_case: allow(STORE),
  reply_to_requester: allow(STORE),
  route_ticket: allow(STORE),
  save_investigation_document: allow(STORE),
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
  write_file: allow(SANDBOX),
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
