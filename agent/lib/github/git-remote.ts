import type { GitHubChannelCredentials } from "eve/channels/github";
import type { SandboxNetworkPolicy } from "eve/sandbox";

const PROTECTED_BRANCHES = new Set(["main", "master"]);

/**
 * Conservative subset of valid git branch names: alphanumeric segments
 * separated by `.`, `_`, `-` or `/`. Everything the git commands interpolate
 * has to match this, so shell metacharacters can never reach the command
 * line.
 */
const BRANCH_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/;

/**
 * Where the station sandboxes keep the factory repository checkout.
 */
export const REPO_DIR = "/workspace/repo";

/**
 * Returns the refusal reason, or null when the branch name may be used in a
 * git command.
 *
 * @remarks
 * `refs/heads/main` and `HEAD` would reach a protected branch under another
 * name, so only plain branch names are accepted, and the protected branches
 * themselves are refused outright: the factory delivers pull requests, never
 * direct pushes to the default branch.
 */
export function validateBranch(branch: string): string | null {
  const components = branch.split("/");
  if (
    !BRANCH_PATTERN.test(branch) ||
    branch.includes("..") ||
    branch.includes("//") ||
    components.some(
      (component) =>
        component.startsWith(".") ||
        component.endsWith(".") ||
        component.endsWith(".lock")
    )
  ) {
    return `"${branch}" is not a valid branch name.`;
  }
  if (branch.startsWith("refs/") || branch === "HEAD") {
    return `"${branch}" is not a plain branch name. Pass the branch name without a refs/ prefix.`;
  }
  if (PROTECTED_BRANCHES.has(branch)) {
    return `Direct pushes to ${branch} are not allowed. Push a feature branch and open a pull request.`;
  }
  return null;
}

/**
 * Firewall policy that brokers the installation token onto egress to
 * github.com only, mirroring the shape eve's own channel checkout uses.
 *
 * @remarks
 * The token never enters the sandbox process; the firewall injects the header
 * on the way out. `"*": []` keeps general egress open so package installs and
 * test runs keep working while the policy is active.
 */
export function brokerPolicy(installationToken: string): SandboxNetworkPolicy {
  const authorization = `Basic ${Buffer.from(
    `x-access-token:${installationToken}`
  ).toString("base64")}`;
  return {
    allow: {
      "*": [],
      "github.com": [
        { transform: [{ headers: { Authorization: authorization } }] },
      ],
    },
  };
}

/**
 * Resolves the Connect-managed installation token, minting when it is lazy.
 */
export async function mintInstallationToken(
  credentials: GitHubChannelCredentials
): Promise<string> {
  const token = credentials.installationToken;
  if (token === undefined) {
    throw new Error("The GitHub connector exposes no installation token.");
  }
  return typeof token === "function" ? await token() : token;
}
