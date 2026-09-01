import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionAuthContext } from "eve/context";
import type { SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";
import { REPOSITORY_MARKER, stampRepository } from "./repository.js";

process.env.LINEAR_CONNECTOR ??= "linear/test";
process.env.PLANETSCALE_MCP_CONNECTOR ??= "planet-scale-read-only-foreman/test";

const { default: pushBranch, pushPreparedBranch } = await import(
  "../tools/push_branch.js"
);

const PREPARED = "Acquisity/Foreman";
const WORKTREE = "/workspace/repo";
// A branch a person would push by hand: no `foreman/` prefix anywhere in it.
const HUMAN_BRANCH = "afragahaha/eng-13319";
const SHA = "9f1c0a2b3d4e5f60718293a4b5c6d7e8f9012345";
// The exact command a delivered push has to run: the validated literal GitHub
// URL of the prepared repository, and a fully qualified refspec.
const PUSH_COMMAND = `git -C '${WORKTREE}' push https://github.com/${PREPARED}.git 'refs/heads/${HUMAN_BRANCH}:refs/heads/${HUMAN_BRANCH}'`;
const REV_PARSE_COMMAND = `git -C '${WORKTREE}' rev-parse '${HUMAN_BRANCH}'`;
const NOT_ALLOWED = /not allowed/u;
const OTHER_REPOSITORY = /Acquisity\/Other/u;

const baseAuth: SessionAuthContext = {
  attributes: {},
  authenticator: "slack",
  principalId: "user:1",
  principalType: "user",
};

const signedFor = (slug: string): SessionAuthContext =>
  stampRepository(baseAuth, slug, "github-webhook");

interface Run {
  command: string;
}

const fakeSandbox = () => {
  const commands: Run[] = [];
  const policies: (SandboxNetworkPolicy | string)[] = [];
  const sandbox = {
    readTextFile: ({ path }: { path: string }) =>
      Promise.resolve(
        path === REPOSITORY_MARKER
          ? JSON.stringify({
              slug: PREPARED,
              source: "github-webhook",
              worktree: WORKTREE,
            })
          : null
      ),
    run: (options: Run) => {
      commands.push(options);
      return Promise.resolve({
        exitCode: 0,
        stderr: "",
        // Only `rev-parse` reports a commit; a push writes nothing to stdout.
        stdout: options.command.includes("rev-parse") ? `${SHA}\n` : "",
      });
    },
    setNetworkPolicy: (policy: SandboxNetworkPolicy | string) => {
      policies.push(policy);
      return Promise.resolve();
    },
  } as unknown as SandboxSession;
  return { commands, policies, sandbox };
};

/**
 * Runs the push with `console.warn` captured and the credential window
 * stubbed, so an accepted push reaches the git commands instead of stopping at
 * a token only a Connect runtime can mint.
 */
const push = async (branch: string, current: SessionAuthContext | null) => {
  const { commands, policies, sandbox } = fakeSandbox();
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (line: unknown) => {
    warnings.push(String(line));
  };
  let sandboxes = 0;
  let brokered = 0;
  const context = {
    getSandbox: () => {
      sandboxes += 1;
      return Promise.resolve(sandbox);
    },
    session: { auth: { current } },
  };
  try {
    const result = await pushPreparedBranch(branch, context, () => {
      brokered += 1;
      return Promise.resolve();
    });
    return { brokered, commands, policies, result, sandboxes, warnings };
  } finally {
    console.warn = original;
  }
};

const outcome = (result: unknown) =>
  result as {
    branch?: string;
    error?: string;
    sha?: string;
    success?: boolean;
  };

describe("push_branch branch names", () => {
  it("pushes a validated human branch name with no foreman/ prefix", async () => {
    const { brokered, commands, policies, result, sandboxes, warnings } =
      await push(HUMAN_BRANCH, signedFor(PREPARED));

    assert.deepEqual(outcome(result), {
      branch: HUMAN_BRANCH,
      sha: SHA,
      success: true,
    });
    assert.deepEqual(
      commands.map((run) => run.command),
      [PUSH_COMMAND, REV_PARSE_COMMAND]
    );
    assert.equal(sandboxes, 1);
    assert.equal(brokered, 1);
    // The credential window closes even on the accepted path.
    assert.deepEqual(policies, ["allow-all"]);
    assert.deepEqual(warnings, []);
  });

  for (const branch of ["main", "master"]) {
    it(`refuses ${branch} before reaching a sandbox`, async () => {
      const { result, sandboxes, warnings } = await push(branch, null);

      assert.equal(outcome(result).success, false);
      assert.match(outcome(result).error ?? "", NOT_ALLOWED);
      assert.equal(sandboxes, 0);
      assert.equal(warnings.length, 1);
    });
  }

  for (const branch of [
    "refs/heads/feature",
    "HEAD",
    "feature/../../etc",
    "feature;rm -rf /",
  ]) {
    it(`refuses unsafe branch ${branch}`, async () => {
      const { result, sandboxes, warnings } = await push(branch, null);

      assert.equal(outcome(result).success, false);
      assert.equal(sandboxes, 0);
      assert.equal(warnings.length, 1);
    });
  }

  it("routes the tool through the same push", async () => {
    const original = console.warn;
    console.warn = () => {
      // The refusal warning is not under test here.
    };
    try {
      const result = await pushBranch.execute({ branch: "main" }, {
        getSandbox: () => Promise.reject(new Error("unreachable")),
        session: { auth: { current: null } },
      } as unknown as Parameters<typeof pushBranch.execute>[1]);

      assert.equal(outcome(result).success, false);
      assert.match(outcome(result).error ?? "", NOT_ALLOWED);
    } finally {
      console.warn = original;
    }
  });
});

describe("push_branch repository binding", () => {
  it("refuses a signed session pushing to another repository", async () => {
    const { commands, result, warnings } = await push(
      HUMAN_BRANCH,
      signedFor("Acquisity/Other")
    );

    assert.equal(outcome(result).success, false);
    assert.match(outcome(result).error ?? "", OTHER_REPOSITORY);
    assert.deepEqual(commands, []);
    assert.equal(warnings.length, 1);
  });

  it("lets an explicit authority push the prepared repository", async () => {
    const { commands, result, warnings } = await push(
      HUMAN_BRANCH,
      stampRepository(baseAuth, "Acquisity/Other", "explicit")
    );

    assert.deepEqual(outcome(result), {
      branch: HUMAN_BRANCH,
      sha: SHA,
      success: true,
    });
    // The prepared repository decides the remote, never the stamped default.
    assert.deepEqual(
      commands.map((run) => run.command),
      [PUSH_COMMAND, REV_PARSE_COMMAND]
    );
    assert.deepEqual(warnings, []);
  });
});

describe("push_branch refusal warnings", () => {
  it("emits one bounded single-line JSON warning per refusal", async () => {
    const { warnings } = await push("main", null);

    assert.equal(warnings.length, 1);
    const [line] = warnings;
    assert.equal(line.includes("\n"), false);
    assert.deepEqual(JSON.parse(line), {
      code: "invalid_branch",
      event: "push_branch.refused",
      message:
        "Direct pushes to main are not allowed. Push a feature branch and open a pull request.",
    });
  });
});
