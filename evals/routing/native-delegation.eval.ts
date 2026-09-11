import { defineEval } from "eve/evals";
import { WRITE_TOOLS } from "../helpers.js";

const FIRST_RESULT = /FIRST=42/u;
const SECOND_RESULT = /SECOND=nevar/u;

export default defineEval({
  description:
    "Two native root-agent copies finish independent read-only sandbox tasks and return both results to the parent.",
  tags: ["slow", "delegation"],
  async test(t) {
    await t.send(
      "Use the native agent tool twice for two independent tasks. Give each child all its context. First child: run a read-only shell command computing 17 + 25 and return FIRST=<computed result>. Second child: run a read-only shell command reversing raven and return SECOND=<reversed word>. Do not use critic or vision, create files, access providers, or delegate further. Wait for both children and report their actual results."
    );
    t.succeeded();
    t.noFailedActions();
    t.event("subagent.called", { count: 2, data: { toolName: "agent" } });
    t.event("subagent.completed", { count: 2 });
    t.event("subagent.completed", { data: { output: FIRST_RESULT } });
    t.event("subagent.completed", { data: { output: SECOND_RESULT } });
    t.notEvent("subagent.called", { data: { toolName: "critic" } });
    t.notEvent("subagent.called", { data: { toolName: "vision" } });
    t.messageIncludes("FIRST=42");
    t.messageIncludes("SECOND=nevar");
    for (const tool of WRITE_TOOLS) {
      t.notCalledTool(tool);
    }
  },
  timeoutMs: 600_000,
});
