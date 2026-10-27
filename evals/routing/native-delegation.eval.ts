import type { MessageStreamEvent } from "eve/client";
import { defineEval, type EveEvalSession } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { WRITE_TOOLS } from "../helpers.js";

const FIRST_RESULT = /^\s*FIRST=42\s*$/u;
const SECOND_RESULT = /^\s*SECOND=nevar\s*$/u;
const FIRST_REPLY_LINE = /^FIRST=42$/mu;
const SECOND_REPLY_LINE = /^SECOND=nevar$/mu;
const COMPUTATIONS = [
  {
    command: "printf 'FIRST=%s\\n' \"$((17 + 25))\"",
    line: "FIRST=42",
    output: FIRST_RESULT,
  },
  {
    command: `word=raven; reversed=; for ((i=4; i>=0; i--)); do reversed+="\${word:i:1}"; done; printf 'SECOND=%s\\n' "$reversed"`,
    line: "SECOND=nevar",
    output: SECOND_RESULT,
  },
] as const;
const RECEIPT = /^Started task (\S+)\. /u;
// The root may wait for its children and check its reply before delivery.
const ROOT_CONTROL_TOOLS = new Set(["eve__task_wait", "check_reply"]);

const finalMessage = (events: readonly MessageStreamEvent[]) =>
  events
    .filter((event) => event.type === "message.completed")
    .filter(
      (event) =>
        event.data.finishReason !== "tool-calls" &&
        Boolean(event.data.message?.trim())
    )
    .at(-1);

export default defineEval({
  description:
    "Two native tasks return working receipts, finish distinct read-only sandbox computations, and deliver their actual results before the held parent turn ends.",
  tags: ["slow", "delegation"],
  async test(t) {
    const signal = AbortSignal.any([t.signal, AbortSignal.timeout(600_000)]);
    let finished = false;
    let session: EveEvalSession | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
    const observe = <T>(work: Promise<T>): Promise<T> =>
      Promise.race([work, aborted]);
    try {
      signal.throwIfAborted();
      session = await observe(t.session({ signal }));
      // eve holds the turn open while its tasks work, so this one turn carries
      // both receipts, both settled tasks, and the final reply.
      const launch = await observe(
        session.send(
          `Use the native agent tool twice for two independent tasks, in this order. Give each child all its context and copy its command verbatim. First agent call: run exactly this one read-only bash command computing 17 + 25: ${COMPUTATIONS[0].command}. Second agent call: run exactly this one read-only bash command reversing raven using Bash built-ins: ${COMPUTATIONS[1].command}. Each child must return only its exact printed result line. Do not use critic, create files, access providers, or delegate further. A working receipt is not a result. Let native background delivery bring both results back; do not poll or repeat the tasks. Only after both children finish, put their actual results on separate lines in your final reply.`,
          { signal }
        )
      );
      launch.expectOk();
      launch.succeeded();
      launch.noFailedActions();
      launch.calledSubagent("agent", { count: 2, status: "completed" });
      const requests = launch.events
        .filter((event) => event.type === "actions.requested")
        .flatMap((event) => event.data.actions)
        .filter(
          (action) =>
            !(
              action.kind === "tool-call" &&
              ROOT_CONTROL_TOOLS.has(action.toolName)
            )
        );
      const calls = requests.filter(
        (action) =>
          action.kind === "subagent-call" &&
          action.name === "agent" &&
          action.subagentName === "agent"
      );
      await t.require(
        requests.length === 2 &&
          calls.length === 2 &&
          new Set(calls.map((call) => call.callId)).size === 2,
        satisfies(
          Boolean,
          "two distinct native agent tool calls and no other actions"
        )
      );
      const receipts = calls.map((call, index) => {
        const expected = COMPUTATIONS[index];
        if (
          !expected ||
          typeof call.input.message !== "string" ||
          !call.input.message.includes(expected.command)
        ) {
          throw new Error(
            `Native call ${call.callId} did not receive its assigned computation.`
          );
        }
        // Native calls return tool-result receipts; child results arrive later.
        const results = launch.events
          .filter((event) => event.type === "action.result")
          .filter((event) => event.data.result.callId === call.callId);
        const [result] = results;
        if (
          results.length !== 1 ||
          result?.data.status !== "completed" ||
          result.data.result.kind !== "tool-result" ||
          result.data.result.toolName !== "agent" ||
          result.data.result.isError
        ) {
          throw new Error(
            `Native call ${call.callId} did not return one successful tool receipt.`
          );
        }
        const { output } = result.data.result;
        const taskId =
          typeof output === "string" ? RECEIPT.exec(output)?.[1] : undefined;
        if (!taskId) {
          throw new Error(
            `Native call ${call.callId} did not return a working task receipt.`
          );
        }
        return { callId: call.callId, expected, taskId };
      });
      await t.require(
        new Set(receipts.map((receipt) => receipt.taskId)).size === 2,
        satisfies(Boolean, "working receipts identify distinct tasks")
      );
      for (const receipt of receipts) {
        launch.event("task.started", {
          count: 1,
          data: {
            callId: receipt.callId,
            kind: "agent",
            name: "agent",
            taskId: receipt.taskId,
          },
        });
        launch.event("task.settled", {
          count: 1,
          data: {
            callId: receipt.callId,
            output: (value: unknown) =>
              JSON.stringify(value).includes(receipt.expected.line),
            status: "completed",
            taskId: receipt.taskId,
          },
        });
      }
      const firstSettled = launch.events.findIndex(
        (event) => event.type === "task.settled"
      );
      const acknowledgement = launch.events
        .slice(0, firstSettled === -1 ? undefined : firstSettled)
        .filter((event) => event.type === "message.completed")
        .map((event) => event.data.message ?? "")
        .join("\n");
      await t.require(
        !(
          FIRST_REPLY_LINE.test(acknowledgement) ||
          SECOND_REPLY_LINE.test(acknowledgement)
        ),
        satisfies(
          Boolean,
          "the launch acknowledgement does not invent a finished child result"
        )
      );
      await t.require(
        FIRST_REPLY_LINE.test(launch.message ?? "") &&
          SECOND_REPLY_LINE.test(launch.message ?? "") &&
          launch.inputRequests.length === 0,
        satisfies(
          Boolean,
          "the held turn answers with both results without parking or repeating work"
        )
      );
      const started = launch.events.filter(
        (event) => event.type === "agent.started"
      );
      const children = await observe(
        Promise.all(
          receipts.map(async (receipt) => {
            const call = started.find(
              (event) => event.data.callId === receipt.callId
            );
            await t.require(
              call?.data.taskId === receipt.taskId &&
                call.data.name === "agent",
              satisfies(
                Boolean,
                "actual child dispatch matches its native working receipt"
              )
            );
            if (!call) {
              throw new Error(`Native call ${receipt.callId} opened no child.`);
            }
            const child = await t.target.attachSession(call.data.sessionId);
            child.succeeded();
            child.noFailedActions();
            child.notEvent("task.started", { data: { kind: "agent" } });

            const result = finalMessage(child.events);
            const line = result?.data.message?.trim();
            await t.require(
              line === receipt.expected.line,
              satisfies(
                Boolean,
                "child returns exactly its computed result line"
              )
            );
            child.calledTool("bash", {
              count: 1,
              input: { command: receipt.expected.command },
              output: {
                exitCode: 0,
                stderr: "",
                stdout: receipt.expected.output,
              },
              status: "completed",
            });
            const childRequests = child.events
              .filter((event) => event.type === "actions.requested")
              .flatMap((event) => event.data.actions);
            const completed = child.events.find(
              (event) => event.type === "turn.completed"
            );
            await t.require(
              completed !== undefined &&
                child.pendingInputRequests.length === 0 &&
                childRequests.length === 1 &&
                childRequests[0]?.kind === "tool-call" &&
                childRequests[0].toolName === "bash",
              satisfies(
                Boolean,
                "child settles one sandbox computation without other tools or pending input"
              )
            );
            return {
              at: Date.parse(completed?.meta.at ?? ""),
              childId: call.data.sessionId,
              line,
            };
          })
        )
      );
      await t.require(
        new Set(children.map((child) => child.childId)).size === 2 &&
          new Set(children.map((child) => child.line)).size === 2,
        satisfies(
          Boolean,
          "each computation comes from a different child session"
        )
      );
      const parentCalls = launch.events
        .filter((event) => event.type === "task.started")
        .filter((event) => event.data.kind === "agent");
      await t.require(
        parentCalls.length === 2 &&
          parentCalls.every((event) =>
            receipts.some(
              (receipt) =>
                event.data.callId === receipt.callId &&
                event.data.taskId === receipt.taskId
            )
          ),
        satisfies(
          Boolean,
          "only the two admitted native children were dispatched"
        )
      );
      launch.messageIncludes(FIRST_REPLY_LINE);
      launch.messageIncludes(SECOND_REPLY_LINE);
      const reply = finalMessage(launch.events);
      const replyAt = Date.parse(reply?.meta.at ?? "");
      await t.require(
        children.every(
          (child) => Number.isFinite(child.at) && replyAt >= child.at
        ),
        satisfies(
          Boolean,
          "the held turn delivers both actual results after both children settle"
        )
      );
      t.succeeded();
      t.noFailedActions();
      for (const tool of [...WRITE_TOOLS, "write_file", "edit_file"]) {
        t.notCalledTool(tool);
      }
      finished = true;
    } finally {
      if (!finished && session) {
        // session.cancel() stops the turn and every working task, so a failed
        // or aborted evaluation also cancels background work.
        try {
          const result = await Promise.race([
            session.cancel(),
            new Promise<never>((_resolve, reject) =>
              setTimeout(() => reject(new Error("timeout")), 10_000).unref()
            ),
          ]);
          t.log(
            `Turn and task cancellation cleanup returned ${result.status}; acceptance alone does not prove settlement.`
          );
        } catch {
          t.log(
            "Turn and task cancellation cleanup failed; inspect this eval session before continuing."
          );
        }
      }
    }
  },
  timeoutMs: 600_000,
});
