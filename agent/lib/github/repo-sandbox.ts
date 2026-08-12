import type {
  SandboxBootstrapContext,
  SandboxSession,
  SandboxSessionContext,
} from "eve/sandbox";
import { FACTORY_REPO } from "../constants.js";
import { githubCredentials } from "./credentials.js";
import {
  brokerPolicy,
  mintInstallationToken,
  REMOTE_URL,
} from "./git-remote.js";

/**
 * Runs a command in the sandbox and throws on a nonzero exit, so a broken
 * clone or setup fails the template build loudly instead of shipping a
 * half-provisioned snapshot to every session.
 */
async function runOrThrow(
  sandbox: SandboxSession,
  command: string
): Promise<void> {
  const result = await sandbox.run({ command });
  if (result.exitCode !== 0) {
    throw new Error(
      `Sandbox command failed (exit ${result.exitCode}): ${command}\n${String(
        result.stderr || result.stdout
      ).trim()}`
    );
  }
}

/**
 * Build-time revalidation key for the station sandboxes.
 *
 * @remarks
 * Changing the target repository or its setup command rebuilds the template;
 * authored sandbox source is tracked by eve automatically.
 */
export function factoryRevalidationKey(): string {
  return `factory-repo-v1:${FACTORY_REPO}:${process.env.FACTORY_SETUP_COMMAND ?? ""}`;
}

/**
 * Template-scoped bootstrap shared by the analyst, implementer, and reviewer
 * sandboxes: clone the factory repository, run its setup command, and set the
 * bot's git identity.
 *
 * @remarks
 * - Runs once per template build, so the clone and dependency install are
 *   paid once and every session inherits the filesystem.
 * - The clone authenticates through the sandbox firewall (the installation
 *   token is injected as a header transform and never enters the sandbox),
 *   which works for private and public repositories alike.
 * - `FACTORY_SETUP_COMMAND` (e.g. `pnpm install`) runs inside the checkout
 *   when set; a failure fails the template build, not a session.
 */
export async function factoryBootstrap({
  use,
}: SandboxBootstrapContext): Promise<void> {
  const sandbox = await use();
  const token = await mintInstallationToken(githubCredentials);
  await sandbox.setNetworkPolicy(brokerPolicy(token));
  try {
    await runOrThrow(sandbox, `git clone --depth 50 ${REMOTE_URL} repo`);
    const setup = process.env.FACTORY_SETUP_COMMAND;
    if (setup) {
      await runOrThrow(sandbox, `cd repo && ${setup}`);
    }
    await runOrThrow(
      sandbox,
      'git config --global user.name "Foreman[bot]" && git config --global user.email "foreman[bot]@users.noreply.github.com"'
    );
  } finally {
    await sandbox.setNetworkPolicy("allow-all");
  }
}

/**
 * Session-scoped setup shared by the station sandboxes: fix git's ownership
 * check and move the checkout to the repository's current default branch.
 *
 * @remarks
 * - The template snapshot is owned by the builder uid, not the session user;
 *   without the `safe.directory` entries every git command dies on "dubious
 *   ownership".
 * - The default branch is read from the clone's `origin/HEAD` rather than
 *   assumed, so repositories whose default is not `main` work unchanged.
 * - The fetch targets {@link REMOTE_URL} literally with a firewall-brokered
 *   credential, mirroring the bootstrap clone.
 */
export async function factoryOnSession({
  use,
}: SandboxSessionContext): Promise<void> {
  const sandbox = await use();
  await runOrThrow(
    sandbox,
    "git config --global --add safe.directory /workspace && git config --global --add safe.directory /workspace/repo"
  );
  const token = await mintInstallationToken(githubCredentials);
  await sandbox.setNetworkPolicy(brokerPolicy(token));
  try {
    await runOrThrow(
      sandbox,
      `cd repo && branch=$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's|^origin/||') && git fetch ${REMOTE_URL} "$branch" && git checkout -B "$branch" FETCH_HEAD`
    );
  } finally {
    await sandbox.setNetworkPolicy("allow-all");
  }
}
