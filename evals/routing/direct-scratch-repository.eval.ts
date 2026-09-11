import assert from "node:assert/strict";
import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "An authorized scratch-repository request delivers a checked feature branch and pull request without merging.",
  tags: ["slow", "needs-connect", "scratch"],
  async test(t) {
    const repository = process.env.FOREMAN_SCRATCH_REPO;
    const ticket = process.env.FOREMAN_SCRATCH_TICKET;
    if (!(repository && ticket)) {
      t.skip(
        "Set FOREMAN_SCRATCH_REPO to a scratch owner/repo and FOREMAN_SCRATCH_TICKET to its existing test Linear ticket."
      );
      return;
    }
    const [owner, repo] = repository.split("/");
    assert.ok(owner && repo && repository === `${owner}/${repo}`);
    const branch = `foreman/uat-${Date.now()}`;
    const turn = await t.send(
      `Work on ${ticket} in scratch repository ${repository}. Add a short Reporting bugs section to the README asking for the version and reproduction steps. Make the change directly, check it, push feature branch ${branch}, and open a normal pull request into main with ${ticket} in its body. Do not merge.`
    );
    // Run through Eve's local-dev or Vercel OIDC eval principal, which carries
    // no Foreman trust stamp. Approve only this run's exact branch and repo.
    assert.equal(turn.inputRequests.length, 1);
    const request = await t.requireInputRequest({
      input: { branch },
      optionIds: ["approve", "cancel"],
      toolName: "push_branch",
    });
    assert.equal(request.kind, "tool-approval");
    const prepared = turn.toolCalls
      .filter((call) => call.name === "prepare_repository")
      .at(-1);
    assert.ok(
      prepared?.output &&
        typeof prepared.output === "object" &&
        "success" in prepared.output &&
        "repository" in prepared.output
    );
    assert.equal(prepared.output.success, true);
    assert.equal(prepared.output.repository, repository);
    const completed = await t.respond([
      { optionId: "approve", requestId: request.requestId },
    ]);
    t.succeeded();
    t.noFailedActions();
    t.calledTool("push_branch", {
      input: { branch },
      output: { success: true },
    });
    const pullRequest = completed.requireToolCall("github__createPullRequest", {
      input: { base: "main", head: branch, owner, repo },
    });
    assert.ok(typeof pullRequest.input.body === "string");
    assert.ok(pullRequest.input.body.includes(ticket));
    t.judge.autoevals
      .closedQA(
        "Does the reply link a concrete pull request, describe the change and checks, and leave merging to a human?"
      )
      .atLeast(0.5);
  },
  timeoutMs: 1_800_000,
});
