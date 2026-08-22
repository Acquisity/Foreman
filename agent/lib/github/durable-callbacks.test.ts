import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionAuthContext } from "eve/context";
import type { ApprovalContext, ApprovalStatus } from "eve/tools";
import { stampIntakeOnly, stampTrusted } from "../trust.js";
import {
  compactGithubOutput,
  durableIntakeOnlyApproval,
  durableReadinessApproval,
} from "./durable-callbacks.js";

const auth: SessionAuthContext = {
  attributes: {},
  authenticator: "slack",
  principalId: "user:1",
  principalType: "user",
};

const approvalFor = (current: SessionAuthContext, toolInput?: unknown) =>
  ({ session: { auth: { current } }, toolInput }) as unknown as ApprovalContext;

/**
 * The carriers hold the policy itself until eve's build transform replaces the
 * property with a stamped wrapper, so a plain test run exercises the real gate.
 */
const decide = (approval: unknown, ctx: ApprovalContext): ApprovalStatus => {
  assert.equal(typeof approval, "function");
  return (approval as (context: ApprovalContext) => ApprovalStatus)(ctx);
};

const HUGE = "x".repeat(50_000);
const TRUNCATION_NOTE = /\[truncated: 30000 more characters\]$/u;
const patchLength = 4036;
const contentLength = 20_036;

describe("compactGithubOutput", () => {
  it("truncates a file body and keeps the rest of the result", () => {
    const output = compactGithubOutput({ content: HUGE, path: "a.ts" }) as {
      content: string;
      path: string;
    };
    assert.equal(output.content.length, contentLength);
    assert.match(output.content, TRUNCATION_NOTE);
    assert.equal(output.path, "a.ts");
  });

  it("truncates patches in a bare file list", () => {
    const output = compactGithubOutput([{ filename: "a.ts", patch: HUGE }]) as {
      filename: string;
      patch: string;
    }[];
    assert.equal(output[0].patch.length, patchLength);
    assert.equal(output[0].filename, "a.ts");
  });

  it("truncates patches nested under files", () => {
    const output = compactGithubOutput({
      files: [{ patch: HUGE }],
      sha: "abc",
    }) as { files: { patch: string }[]; sha: string };
    assert.equal(output.files[0].patch.length, patchLength);
    assert.equal(output.sha, "abc");
  });

  it("leaves short values and unpatched files alone", () => {
    for (const output of [
      { content: "short" },
      { files: [{ filename: "a.ts" }] },
      { number: 7 },
      [],
      null,
      "text",
    ]) {
      assert.deepEqual(compactGithubOutput(output), output);
    }
  });
});

describe("durable approvals", () => {
  it("carries the intake-only gate to createPullRequest", () => {
    const stamped = stampIntakeOnly(stampTrusted(auth));
    const status = decide(durableIntakeOnlyApproval, approvalFor(stamped));
    assert.equal(typeof status === "object" && status.type, "denied");
  });

  it("leaves an ordinary session free to open a pull request", () => {
    const status = decide(durableIntakeOnlyApproval, approvalFor(auth));
    assert.equal(status, "not-applicable");
  });

  it("carries the readiness gate to updatePullRequest", () => {
    const status = decide(
      durableReadinessApproval,
      approvalFor(auth, { draft: false })
    );
    assert.equal(typeof status === "object" && status.type, "denied");
  });

  it("leaves every other pull request update ungated", () => {
    for (const input of [{ draft: true }, { title: "new title" }, undefined]) {
      assert.equal(
        decide(durableReadinessApproval, approvalFor(auth, input)),
        "not-applicable"
      );
    }
  });

  it("does not share a gate between the two carriers", () => {
    assert.notEqual(durableIntakeOnlyApproval, durableReadinessApproval);
  });
});
