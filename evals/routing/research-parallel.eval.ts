import type { MessageStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";

// Index of the first subagent.called event for the named station, or -1.
const firstCalled = (
  events: readonly MessageStreamEvent[],
  name: string
): number =>
  events.findIndex(
    (event) =>
      event.type === "subagent.called" &&
      (event.data as { name?: unknown }).name === name
  );

// Index of the first subagent.completed event for the named station, or -1.
const firstCompleted = (
  events: readonly MessageStreamEvent[],
  name: string
): number =>
  events.findIndex(
    (event) =>
      event.type === "subagent.completed" &&
      (event.data as { subagentName?: unknown }).subagentName === name
  );

export default defineEval({
  description:
    "A work item that plainly turns on an external fact loads the factory-pipeline skill and sends the researcher out alongside the classifier: both are dispatched before either returns, and both finish before the analyst plans.",
  tags: ["slow", "needs-connect"],
  async test(t) {
    await t.send(
      "Work item: our date parsing breaks on the new RFC 9557 timezone suffix format; we need to confirm what the released spec actually says and plan a fix. Classify this and produce the implementation plan, but stop after analysis and report the plan to me; do not implement anything yet."
    );
    t.succeeded();
    t.loadedSkill("factory-pipeline");
    t.calledSubagent("classifier");
    t.calledSubagent("researcher");
    t.calledSubagent("analyst");
    t.calledSubagent("implementer", { count: 0 });
    t.eventsSatisfy(
      "classifier and researcher dispatch overlaps: both are delegated before either completes",
      (events) => {
        const classifierCalled = firstCalled(events, "classifier");
        const researcherCalled = firstCalled(events, "researcher");
        const firstDone = Math.min(
          ...[
            firstCompleted(events, "classifier"),
            firstCompleted(events, "researcher"),
          ].filter((index) => index !== -1)
        );
        return (
          classifierCalled !== -1 &&
          researcherCalled !== -1 &&
          classifierCalled < firstDone &&
          researcherCalled < firstDone
        );
      }
    );
    t.eventsSatisfy(
      "the analyst is delegated only after classifier and researcher both complete",
      (events) => {
        const analystCalled = firstCalled(events, "analyst");
        const classifierDone = firstCompleted(events, "classifier");
        const researcherDone = firstCompleted(events, "researcher");
        return (
          analystCalled !== -1 &&
          classifierDone !== -1 &&
          researcherDone !== -1 &&
          classifierDone < analystCalled &&
          researcherDone < analystCalled
        );
      }
    );
  },
});
