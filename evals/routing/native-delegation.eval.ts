import { defineEval } from "eve/evals";
import { WRITE_TOOLS } from "../helpers.js";

const FIRST_RESULT = /^\s*FIRST=42\s*$/u;
const SECOND_RESULT = /^\s*SECOND=nevar\s*$/u;
const FIRST_REPLY_LINE = /^FIRST=42$/mu;
const SECOND_REPLY_LINE = /^SECOND=nevar$/mu;

export default defineEval({
  description:
    "Two native root-agent copies finish independent read-only sandbox tasks and return both results to the parent.",
  tags: ["slow", "delegation"],
  async test(t) {
    const parent = await t.send(
      "Use the native agent tool twice for two independent tasks. Give each child all its context. First child: run a read-only shell command computing 17 + 25 and printing FIRST=<computed result>. Second child: run a read-only shell command reversing raven and printing SECOND=<reversed word>. Each child must return only its exact printed result line. Do not use critic or vision, create files, access providers, or delegate further. Wait for both children and put their actual results on separate lines in your final reply."
    );
    t.succeeded();
    t.noFailedActions();
    t.event("subagent.called", { count: 2, data: { toolName: "agent" } });
    t.event("subagent.completed", { count: 2 });
    t.event("subagent.completed", { count: 1, data: { output: FIRST_RESULT } });
    t.event("subagent.completed", {
      count: 1,
      data: { output: SECOND_RESULT },
    });
    t.notEvent("subagent.called", { data: { toolName: "critic" } });
    t.notEvent("subagent.called", { data: { toolName: "vision" } });
    parent.messageIncludes(FIRST_REPLY_LINE);
    parent.messageIncludes(SECOND_REPLY_LINE);
    for (const tool of WRITE_TOOLS) {
      t.notCalledTool(tool);
    }

    const calls = parent.events
      .filter((event) => event.type === "subagent.called")
      .filter(({ data }) => data.toolName === "agent");
    const completions = parent.events.filter(
      (event) => event.type === "subagent.completed"
    );
    const first = completions.find(
      ({ data }) =>
        typeof data.output === "string" && FIRST_RESULT.test(data.output)
    );
    const second = completions.find(
      ({ data }) =>
        typeof data.output === "string" && SECOND_RESULT.test(data.output)
    );
    const firstCall = calls.find(
      ({ data }) => data.callId === first?.data.callId
    );
    const secondCall = calls.find(
      ({ data }) => data.callId === second?.data.callId
    );
    const distinct =
      firstCall !== undefined &&
      secondCall !== undefined &&
      firstCall.data.callId !== secondCall.data.callId &&
      firstCall.data.childSessionId !== secondCall.data.childSessionId;
    t.eventsSatisfy(
      "each expected result came from a distinct native child",
      () => distinct
    );
    if (!(distinct && firstCall && secondCall)) {
      return;
    }
    // Eve 0.44 can read each completed child stream directly. Keep shell
    // evidence scoped to that child and final-delivery evidence scoped to parent.
    await Promise.all(
      (
        [
          [firstCall, FIRST_RESULT],
          [secondCall, SECOND_RESULT],
        ] as const
      ).map(async ([call, result]) => {
        const child = await t.target.attachSession(call.data.childSessionId);
        child.succeeded();
        child.calledTool("bash", {
          output: { exitCode: 0, stdout: result },
          status: "completed",
        });
      })
    );
  },
  timeoutMs: 600_000,
});
