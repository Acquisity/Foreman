import type { SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";

// The commit identity resolves from the environment, so a switch never reaches
// the connector metadata call a Connect runtime would have to serve. Stamped
// here so it is set before either test file imports the tool.
process.env.FOREMAN_BOT_NAME ??= "Foreman";

process.env.LINEAR_CONNECTOR ??= "linear/test";
process.env.PLANETSCALE_MCP_CONNECTOR ??= "planet-scale-read-only-foreman/test";

export const REPOSITORY = "Acquisity/Foreman";
export const DISCARD = "rm -rf /workspace/repo";
export const STAGING = "/workspace/.repo-staging";
export const DISCARD_STAGING = `rm -rf ${STAGING}`;
export const PUBLISH = `mv ${STAGING} /workspace/repo`;
export const TIMEOUT_MS = 20;
export const HEAD_BEFORE = "1111111111111111111111111111111111111111";
export const HEAD_AFTER = "2222222222222222222222222222222222222222";
export const CLONE_FAILED = /repository not found/u;
export const CLONE_THREW = /sandbox gone/u;
export const CANCELLED = /turn cancelled/u;

export interface RunOptions {
  abortSignal?: AbortSignal;
  command: string;
}

export interface RunResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export const ok = (stdout = ""): Promise<RunResult> =>
  Promise.resolve({ exitCode: 0, stderr: "", stdout });

export const failed = (stderr: string): Promise<RunResult> =>
  Promise.resolve({ exitCode: 1, stderr, stdout: "" });

/** Never settles until the caller's deadline aborts it. */
export const stall = (options: RunOptions): Promise<RunResult> =>
  new Promise((_resolve, reject) => {
    options.abortSignal?.addEventListener("abort", () => {
      reject(options.abortSignal?.reason);
    });
  });

export const fakeSandbox = (
  run: (options: RunOptions) => Promise<RunResult>
) => {
  const commands: RunOptions[] = [];
  const policies: SandboxNetworkPolicy[] = [];
  const sandbox = {
    run: (options: RunOptions) => {
      commands.push(options);
      return run(options);
    },
    setNetworkPolicy: (policy: SandboxNetworkPolicy) => {
      policies.push(policy);
      return Promise.resolve();
    },
  } as unknown as SandboxSession;
  return { commands, policies, sandbox };
};

// Stands in for the brokered GitHub token so the tests never mint one; the
// firewall write is what the `finally` has to undo.
export const broker = (sandbox: SandboxSession) =>
  sandbox.setNetworkPolicy({ allow: { "*": [] } });

export const ran = (commands: RunOptions[], needle: string) =>
  commands.some((options) => options.command.includes(needle));
