import type { SessionAuthContext } from "eve/context";
import type { SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { resolveToken } from "#lib/jev.js";
import { logOpsEvent } from "#lib/ops-log.js";
import { readPreparedRepository } from "#lib/repository.js";
import { repositoryCapabilitiesAvailable } from "#lib/repository-lane.js";
import { boundedRun } from "#lib/sandbox-deadline.js";
import { isTrusted, isUnattended } from "#lib/trust.js";

/**
 * One eval run: the subject's dev server boot, its build, and the selected
 * evals against a live model. Ten minutes covers a cold build plus a handful of
 * evals and still returns before eve's 800s Vercel invocation ceiling.
 */
export const EVAL_TIMEOUT_MS = 600_000;

/** Eval ids and directory prefixes, e.g. `smoke` or `routing/direct-scratch-repository`. */
const FILTER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/;

const SUMMARY_CHARS = 4000;
const ERROR_CHARS = 500;
const ERROR_LINE = /error/iu;

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

const refuse = (code: string, error: string) => {
  logOpsEvent("run_eval.refused", { code, message: error }, console.warn);
  return { error, success: false as const };
};

interface EvalContext {
  getSandbox: () => Promise<SandboxSession>;
  session: {
    auth: {
      current: SessionAuthContext | null;
      initiator?: SessionAuthContext | null;
    };
  };
}

/**
 * Runs `pnpm eval` in the prepared repository with a placeholder gateway key
 * in the command env and the real credential injected at the firewall.
 */
export const runPreparedEval = async (
  filter: string | undefined,
  ctx: EvalContext,
  broker: GatewayBroker = brokerGatewayToken
) => {
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
  let worktree: string;
  try {
    ({ worktree } = await readPreparedRepository(sandbox));
  } catch (error) {
    return refuse(
      "no_repository",
      error instanceof Error ? error.message : String(error)
    );
  }
  try {
    await broker(sandbox);
    const result = await boundedRun(
      sandbox,
      {
        command: `cd '${worktree}' && set -a && . ./.env.example && set +a && AI_GATEWAY_API_KEY=placeholder pnpm eval${filter ? ` '${filter}'` : ""} 2>&1`,
      },
      EVAL_TIMEOUT_MS
    );
    const output = String(result.stdout || result.stderr);
    const firstError =
      result.exitCode === 0
        ? undefined
        : output.split("\n").find((line) => ERROR_LINE.test(line));
    return {
      exitCode: result.exitCode,
      firstError: firstError?.trim().slice(0, ERROR_CHARS) ?? null,
      success: result.exitCode === 0,
      summary: output.trim().slice(-SUMMARY_CHARS),
    };
  } finally {
    await sandbox.setNetworkPolicy("allow-all");
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
