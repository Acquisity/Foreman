import type { MessageStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { z } from "zod";
import { WRITE_TOOLS } from "../helpers.js";

const FIRST_RESULT = /^\s*FIRST=42\s*$/u;
const SECOND_RESULT = /^\s*SECOND=nevar\s*$/u;
const FIRST_REPLY_LINE = /^FIRST=42$/mu;
const SECOND_REPLY_LINE = /^SECOND=nevar$/mu;
const workingReceipt = z.object({
  agentId: z.string().min(1),
  status: z.literal("working"),
  taskId: z.string().min(1),
});

const finalMessage = (events: readonly MessageStreamEvent[]) =>
  events
    .filter((event) => event.type === "message.completed")
    .find(
      (event) =>
        event.data.finishReason !== "tool-calls" &&
        Boolean(event.data.message?.trim())
    );

const resultLine = (
  message: string
): "FIRST=42" | "SECOND=nevar" | undefined => {
  if (FIRST_RESULT.test(message)) {
    return "FIRST=42";
  }
  return SECOND_RESULT.test(message) ? "SECOND=nevar" : undefined;
};

export default defineEval({
  description:
    "Two native background tasks return working receipts, finish distinct read-only sandbox computations, and deliver their actual results in a later parent turn.",
  tags: ["slow", "delegation"],
  async test(t) {
    const signal = AbortSignal.any([t.signal, AbortSignal.timeout(600_000)]);
    let finished = false;
    const aborted = new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
    const observe = <T>(work: Promise<T>): Promise<T> =>
      Promise.race([work, aborted]);
    try {
      signal.throwIfAborted();
      const launch = await observe(
        t.send(
          "Use the native agent tool twice for two independent tasks. Give each child all its context. First child: run exactly one read-only bash command computing 17 + 25 and printing FIRST=<computed result>. Second child: run exactly one read-only bash command reversing raven and printing SECOND=<reversed word>. Use Bash built-ins only: assign word=raven and reversed=, loop i from 4 down to 0 appending each character to reversed with Bash substring expansion, then print it with printf. Do not assume external utilities such as rev are installed. Each child must return only its exact printed result line. Do not use critic or vision, create files, access providers, or delegate further. A working receipt is not a result. Let native background delivery bring both results back; do not poll or repeat the tasks. Only after both children finish, put their actual results on separate lines in your final reply.",
          { signal }
        )
      );
      launch.expectOk();
      launch.succeeded();
      launch.noFailedActions();
      launch.calledTool("agent", {
        count: 2,
        output: { status: "working" },
        status: "completed",
      });
      const requests = launch.events
        .filter((event) => event.type === "actions.requested")
        .flatMap((event) => event.data.actions);
      const calls = requests.filter(
        (action) => action.kind === "tool-call" && action.toolName === "agent"
      );
      await t.require(
        requests.length === 2 &&
          calls.length === 2 &&
          new Set(calls.map((call) => call.callId)).size === 2,
        satisfies(
          Boolean,
          "two distinct native agent tool calls and no other launch actions"
        )
      );
      const receipts = calls.map((call) => {
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
        return {
          callId: call.callId,
          ...workingReceipt.parse(result.data.result.output),
        };
      });
      await t.require(
        new Set(receipts.map((receipt) => receipt.agentId)).size === 2 &&
          new Set(receipts.map((receipt) => receipt.taskId)).size === 2,
        satisfies(
          Boolean,
          "working receipts identify distinct agents and tasks"
        )
      );
      for (const receipt of receipts) {
        launch.event("subagent.completed", {
          count: 1,
          data: {
            backgroundTask: { status: "working", taskId: receipt.taskId },
            callId: receipt.callId,
            subagentName: "agent",
          },
        });
      }
      await t.require(
        !(
          FIRST_REPLY_LINE.test(launch.message ?? "") ||
          SECOND_REPLY_LINE.test(launch.message ?? "")
        ),
        satisfies(
          Boolean,
          "the launch acknowledgement does not invent a finished child result"
        )
      );
      const cursor = t.state?.streamIndex;
      await t.require(
        cursor !== undefined,
        satisfies(Boolean, "parent continuation cursor is available")
      );
      if (cursor === undefined) {
        return;
      }
      // Native agent admission is a tool result. Actual child dispatch occurs
      // afterward as the waiting parent processes the background invocation.
      // Observe that same durable continuation; never send another prompt.
      const continuation = t.target.watchTurn(launch.sessionId, {
        startIndex: cursor,
      });
      const parentResult = continuation.result().then(async (turn) => {
        turn.expectOk();
        turn.noFailedActions();
        turn.notCalledTool("agent");
        await t.require(
          FIRST_REPLY_LINE.test(turn.message ?? "") &&
            SECOND_REPLY_LINE.test(turn.message ?? "") &&
            turn.inputRequests.length === 0 &&
            !turn.events.some((event) => event.type === "actions.requested"),
          satisfies(
            Boolean,
            "the native continuation answers with both results without parking or repeating work"
          )
        );
        return turn;
      });
      const childResults = Promise.all(
        receipts.map(async (receipt) => {
          const existing = launch.events
            .filter((event) => event.type === "subagent.called")
            .find((event) => event.data.callId === receipt.callId);
          const call =
            existing ??
            (await continuation.waitForEvent("subagent.called", {
              data: {
                agentId: receipt.agentId,
                callId: receipt.callId,
                toolName: "agent",
              },
            }));
          await t.require(
            call.data.agentId === receipt.agentId &&
              call.data.toolName === "agent",
            satisfies(
              Boolean,
              "actual child dispatch matches its native working receipt"
            )
          );
          const child = await t.target.attachSession(call.data.childSessionId);
          child.succeeded();
          child.noFailedActions();
          child.notEvent("subagent.called");

          const result = finalMessage(child.events);
          const line = resultLine(result?.data.message ?? "");
          await t.require(
            line !== undefined,
            satisfies(Boolean, "child returns exactly its computed result line")
          );
          const expected = line === "FIRST=42" ? FIRST_RESULT : SECOND_RESULT;
          child.calledTool("bash", {
            count: 1,
            output: { exitCode: 0, stderr: "", stdout: expected },
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
            childId: call.data.childSessionId,
            line,
          };
        })
      );
      const [children, parent] = await observe(
        Promise.all([childResults, parentResult])
      );
      await t.require(
        new Set(children.map((child) => child.childId)).size === 2 &&
          new Set(children.map((child) => child.line)).size === 2,
        satisfies(
          Boolean,
          "each computation comes from a different child session"
        )
      );
      const parentCalls = [...launch.events, ...parent.events].filter(
        (event) => event.type === "subagent.called"
      );
      await t.require(
        parentCalls.length === 2 &&
          parentCalls.every((event) =>
            receipts.some(
              (receipt) =>
                event.data.callId === receipt.callId &&
                event.data.agentId === receipt.agentId
            )
          ),
        satisfies(
          Boolean,
          "only the two admitted native children were dispatched"
        )
      );
      parent.succeeded();
      parent.messageIncludes(FIRST_REPLY_LINE);
      parent.messageIncludes(SECOND_REPLY_LINE);
      const reply = finalMessage(parent.events);
      const replyAt = Date.parse(reply?.meta.at ?? "");
      await t.require(
        children.every(
          (child) => Number.isFinite(child.at) && replyAt >= child.at
        ),
        satisfies(
          Boolean,
          "the native continuation delivers both actual results after both children settle"
        )
      );
      t.succeeded();
      t.noFailedActions();
      for (const tool of [...WRITE_TOOLS, "write_file", "edit_file"]) {
        t.notCalledTool(tool);
      }
      finished = true;
    } finally {
      if (!finished && t.sessionId) {
        // Eval cancel() has no tasks option. Use the public authenticated
        // endpoint so a failed/aborted evaluation also cancels background work.
        try {
          const response = await t.target.fetch(
            `/eve/v1/session/${encodeURIComponent(t.sessionId)}/cancel`,
            {
              body: JSON.stringify({ tasks: true }),
              headers: { "content-type": "application/json" },
              method: "POST",
              signal: AbortSignal.timeout(10_000),
            }
          );
          if (response.ok) {
            t.log(
              "Background-task cancellation cleanup requested; acceptance alone does not prove settlement."
            );
          } else {
            t.log(
              `Background-task cancellation cleanup returned HTTP ${response.status}.`
            );
          }
        } catch {
          t.log(
            "Background-task cancellation cleanup failed; inspect this eval session before continuing."
          );
        }
      }
    }
  },
  timeoutMs: 600_000,
});
