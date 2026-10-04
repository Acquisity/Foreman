import type { SessionAuthContext, SessionParent } from "eve/context";
import type { SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { summarizeEval } from "#lib/eval-summary.js";
import { resolveToken } from "#lib/jev.js";
import { logOpsEvent } from "#lib/ops-log.js";
import { readPreparedRepository, repositoryFromAuth } from "#lib/repository.js";
import { repositoryCapabilitiesAvailable } from "#lib/repository-lane.js";
import { boundedRun } from "#lib/sandbox-deadline.js";
import { isTrusted, isUnattended } from "#lib/trust.js";

/**
 * One eval run: the subject's dev server boot, its build, and the selected
 * evals against a live model. The shell sends TERM to its process group after
 * 570s, then KILL after 10s, ahead of this 600s outer deadline. Eve 0.54.2 does
 * not propagate cancellation after command creation; see EVE-PROPOSALS.md.
 */
export const EVAL_TIMEOUT_MS = 600_000;

/** Eval ids and directory prefixes, e.g. `smoke` or `routing/direct-scratch-repository`. */
const FILTER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/;

/**
 * Brokers the gateway credential onto egress to the gateway only. The
 * firewall replaces the placeholder `Authorization` header the sandbox sends
 * (probed on Vercel Sandbox 2026-10-04), so the key never enters the sandbox.
 */
export const gatewayPolicy = (token: string): SandboxNetworkPolicy => ({
  allow: {
    "*": [],
    "ai-gateway.vercel.sh": [
      { transform: [{ headers: { Authorization: `Bearer ${token}` } }] },
    ],
  },
});

/** Applies the brokered gateway credential for the duration of one run. */
export type GatewayBroker = (sandbox: SandboxSession) => Promise<void>;

const brokerGatewayToken: GatewayBroker = async (sandbox) => {
  await sandbox.setNetworkPolicy(gatewayPolicy(await resolveToken()));
};

const restorePolicy = async (sandbox: SandboxSession) => {
  try {
    await sandbox.setNetworkPolicy("allow-all");
  } catch {
    try {
      await sandbox.setNetworkPolicy("allow-all");
    } catch (error) {
      logOpsEvent(
        "run_eval.cleanup_failed",
        {
          code: "gateway_transform_stuck",
          message:
            "Could not remove the ai-gateway.vercel.sh credential transform after two attempts.",
        },
        console.error
      );
      throw error;
    }
  }
};

const refuse = (code: string, error: string) => {
  logOpsEvent("run_eval.refused", { code, message: error }, console.warn);
  return { error, success: false as const };
};

interface EvalContext {
  getSandbox: () => Promise<SandboxSession>;
  session: {
    parent?: SessionParent;
    auth: {
      current: SessionAuthContext | null;
      initiator?: SessionAuthContext | null;
    };
  };
}

/**
 * Runs `pnpm eval` in the prepared repository with a placeholder gateway key
 * in the command env and the real credential injected at the firewall.
 * Children are refused because native delegates share the root firewall.
 * Root parallel calls can still overlap another broker's window; no lease is
 * provided by this tool. See EVE-PROPOSALS.md for this accepted limitation.
 */
export const runPreparedEval = async (
  filter: string | undefined,
  ctx: EvalContext,
  broker: GatewayBroker = brokerGatewayToken
) => {
  if (ctx.session.parent) {
    return refuse("child_session", "Only the root session may run evals.");
  }
  const { current, initiator } = ctx.session.auth;
  if (isUnattended(current) || isUnattended(initiator ?? null)) {
    return refuse("unattended", "Unattended runs may not run evals.");
  }
  if (!isTrusted(current)) {
    return refuse("untrusted", "Running evals is limited to trusted callers.");
  }
  if (
    filter !== undefined &&
    (!FILTER_PATTERN.test(filter) || filter.includes(".."))
  ) {
    return refuse("invalid_filter", `"${filter}" is not a valid eval filter.`);
  }
  const sandbox = await ctx.getSandbox();
  let prepared: Awaited<ReturnType<typeof readPreparedRepository>>;
  try {
    prepared = await readPreparedRepository(sandbox);
  } catch (error) {
    return refuse(
      "no_repository",
      error instanceof Error ? error.message : String(error)
    );
  }
  // Same hard gate as push_branch: a signed GitHub session runs only its own repository.
  const authoritative = repositoryFromAuth(current);
  if (
    authoritative?.source === "github-webhook" &&
    authoritative.slug.toLowerCase() !== prepared.slug.toLowerCase()
  ) {
    return refuse(
      "repository_binding",
      `This signed GitHub session is bound to ${authoritative.slug} and cannot run evals in ${prepared.slug}.`
    );
  }
  try {
    await broker(sandbox);
    const result = await boundedRun(
      sandbox,
      {
        // stdout carries only the JSON report; stderr stays separate so late logs cannot replace it.
        command: `cd '${prepared.worktree}' && timeout -k 10s 570s bash -c 'set -a; . ./.env.example; set +a; AI_GATEWAY_API_KEY=placeholder pnpm --silent eval --json "$@"' run_eval${filter ? ` '${filter}'` : ""}`,
      },
      EVAL_TIMEOUT_MS
    );
    return summarizeEval(result.exitCode, String(result.stdout));
  } finally {
    await restorePolicy(sandbox);
  }
};

export const runEvalTool = defineTool({
  description:
    "Run the prepared repository's evals (pnpm eval) against a live model and return the exit code, the summary, and the first error. Pass an eval id or directory prefix as filter, e.g. smoke. Costs real model tokens.",
  execute: ({ filter }, ctx) => runPreparedEval(filter, ctx),
  inputSchema: z.object({ filter: z.string().min(1).max(128).optional() }),
});

/** Gated with the repository lane; see `agent/tools/push_branch.ts`. */
export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      repositoryCapabilitiesAvailable(ctx.session.auth.current, {
        initiator: ctx.session.auth.initiator,
      })
        ? runEvalTool
        : null,
  },
});
