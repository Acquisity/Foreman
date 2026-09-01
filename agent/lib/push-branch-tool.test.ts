import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionAuthContext } from "eve/context";
import type { SandboxSession } from "eve/sandbox";
import { REPOSITORY_MARKER, stampRepository } from "./repository.js";

process.env.LINEAR_CONNECTOR ??= "linear/test";
process.env.PLANETSCALE_MCP_CONNECTOR ??= "planet-scale-read-only-foreman/test";

const { default: pushBranch } = await import("../tools/push_branch.js");

const PREPARED = "Acquisity/Foreman";
// A branch a person would push by hand: no `foreman/` prefix anywhere in it.
const HUMAN_BRANCH = "afragahaha/eng-13319";
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
  const sandbox = {
    readTextFile: ({ path }: { path: string }) =>
      Promise.resolve(
        path === REPOSITORY_MARKER
          ? JSON.stringify({
              slug: PREPARED,
              source: "github-webhook",
              worktree: "/workspace/repo",
            })
          : null
      ),
    run: (options: Run) => {
      commands.push(options);
      return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
    },
    setNetworkPolicy: () => Promise.resolve(),
  } as unknown as SandboxSession;
  return { commands, sandbox };
};

/** Runs the tool with `console.warn` captured, so warnings are assertable. */
const push = async (branch: string, current: SessionAuthContext | null) => {
  const { commands, sandbox } = fakeSandbox();
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (line: unknown) => {
    warnings.push(String(line));
  };
  let sandboxes = 0;
  const context = {
    getSandbox: () => {
      sandboxes += 1;
      return Promise.resolve(sandbox);
    },
    session: { auth: { current } },
  } as unknown as Parameters<typeof pushBranch.execute>[1];
  try {
    const result = await Promise.resolve(
      pushBranch.execute({ branch }, context)
    ).catch((error: unknown) => ({ threw: String(error) }));
    return { commands, result, sandboxes, warnings };
  } finally {
    console.warn = original;
  }
};

const refusalOf = (result: unknown) =>
  result as { error?: string; success?: boolean };

describe("push_branch branch names", () => {
  it("accepts a validated human branch name with no foreman/ prefix", async () => {
    const { result, sandboxes, warnings } = await push(
      HUMAN_BRANCH,
      signedFor(PREPARED)
    );

    // Nothing refused it: the tool read the prepared repository and ran on to
    // the brokered credential, which only a real Connect runtime can mint.
    assert.equal(refusalOf(result).success, undefined);
    assert.equal(sandboxes, 1);
    assert.ok((result as { threw?: string }).threw);
    assert.deepEqual(warnings, []);
  });

  for (const branch of ["main", "master"]) {
    it(`refuses ${branch} before reaching a sandbox`, async () => {
      const { result, sandboxes, warnings } = await push(branch, null);

      assert.equal(refusalOf(result).success, false);
      assert.match(refusalOf(result).error ?? "", NOT_ALLOWED);
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

      assert.equal(refusalOf(result).success, false);
      assert.equal(sandboxes, 0);
      assert.equal(warnings.length, 1);
    });
  }
});

describe("push_branch repository binding", () => {
  it("refuses a signed session pushing to another repository", async () => {
    const { commands, result, warnings } = await push(
      HUMAN_BRANCH,
      signedFor("Acquisity/Other")
    );

    assert.equal(refusalOf(result).success, false);
    assert.match(refusalOf(result).error ?? "", OTHER_REPOSITORY);
    assert.deepEqual(commands, []);
    assert.equal(warnings.length, 1);
  });

  it("lets an explicit authority prepare another repository", async () => {
    const { result, warnings } = await push(
      HUMAN_BRANCH,
      stampRepository(baseAuth, "Acquisity/Other", "explicit")
    );

    assert.equal(refusalOf(result).success, undefined);
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
