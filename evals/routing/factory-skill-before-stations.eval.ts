import type { MessageStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";

// Index of the first load_skill request for the named skill, or -1.
const firstSkillLoad = (
  events: readonly MessageStreamEvent[],
  skill: string
): number =>
  events.findIndex(
    (event) =>
      event.type === "actions.requested" &&
      event.data.actions.some(
        (action) =>
          action.kind === "load-skill" &&
          (action.input as { skill?: unknown }).skill === skill
      )
  );

// Index of the first subagent.called event, or -1.
const firstSubagentCall = (events: readonly MessageStreamEvent[]): number =>
  events.findIndex((event) => event.type === "subagent.called");

export default defineEval({
  description:
    "A repo work item in a general-profile session loads the factory-pipeline skill before any station is delegated, and the pipeline starts with the classifier.",
  tags: ["fast"],
  async test(t) {
    await t.send(
      "Use factory mode for Acquisity/Foreman: users report that password reset emails sometimes arrive twice. Run the full pipeline."
    );
    t.loadedSkill("factory-pipeline");
    t.calledSubagent("classifier");
    t.eventsSatisfy(
      "the factory-pipeline skill loads before the first station is delegated",
      (events) => {
        const skillLoad = firstSkillLoad(events, "factory-pipeline");
        const firstCall = firstSubagentCall(events);
        return skillLoad !== -1 && firstCall !== -1 && skillLoad < firstCall;
      }
    );
  },
});
