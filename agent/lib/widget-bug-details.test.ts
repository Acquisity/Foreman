import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { answerBugDetails, bugDetailsTurn } from "./widget-bug-details.js";

const scores = (goal: number, problem: number, where: number) => ({
  json: () =>
    Promise.resolve({
      answers: {
        says_goal: { noul: goal },
        says_problem: { noul: problem },
        says_where: { noul: where },
      },
      model: "jev-latest",
    }),
  ok: true,
  status: 200,
});

const turn = (reply: ReturnType<typeof scores>, asked: string[] = []) =>
  bugDetailsTurn(
    {
      asked,
      conversation: "my campaign isn't working",
      conversationId: "c0a8012e-0000-4000-8000-000000000001",
    },
    { apiKey: "test-key", fetch: () => Promise.resolve(reply) }
  );

describe("bugDetailsTurn", () => {
  it("asks what went wrong first when the report is a bare complaint", async () => {
    const result = await turn(scores(0.1, 0.1, 0.1));
    assert.equal(result.bug_details, "ask");
    assert.equal(
      result.message,
      "What happened when it went wrong? An error message, or what you saw on the screen, helps a lot."
    );
    assert.equal(result.status, "completed");
    assert.equal(result.decision, "allow");
  });

  it("asks only for the one detail that is missing", async () => {
    assert.equal(
      (await turn(scores(0.9, 0.9, 0.2))).message,
      "Where in Acquisity did this happen? The page name, or the campaign or website you were working on, is perfect."
    );
    assert.equal(
      (await turn(scores(0.2, 0.9, 0.9))).message,
      "What were you trying to do when this happened?"
    );
  });

  it("never repeats a question already asked: a second thin answer moves on to the next missing detail", async () => {
    const problem =
      "What happened when it went wrong? An error message, or what you saw on the screen, helps a lot.";
    assert.equal(
      (await turn(scores(0.1, 0.1, 0.9), [problem])).message,
      "What were you trying to do when this happened?"
    );
    const second = await turn(scores(0.1, 0.1, 0.9), [
      problem,
      "What were you trying to do when this happened?",
    ]);
    assert.equal(second.bug_details, "pass");
    assert.equal(second.message, null);
  });

  it("passes when the report has all three details", async () => {
    const result = await turn(scores(0.8, 0.7, 0.6));
    assert.equal(result.bug_details, "pass");
    assert.equal(result.message, null);
  });

  it("throws without a key, so Acquisity skips to its recording step", async () => {
    await assert.rejects(
      bugDetailsTurn(
        { asked: [], conversation: "x", conversationId: "c" },
        { apiKey: "", fetch: () => assert.fail("must not call Jev") }
      ),
      { message: "no_key" }
    );
  });

  it("throws on a malformed Jev answer", async () => {
    await assert.rejects(
      bugDetailsTurn(
        { asked: [], conversation: "x", conversationId: "c" },
        {
          apiKey: "k",
          fetch: () =>
            Promise.resolve({
              json: () => Promise.resolve({ answers: {} }),
              ok: true,
              status: 200,
            }),
        }
      ),
      z.ZodError
    );
  });
});

describe("answerBugDetails", () => {
  it("passes Foreman's earlier replies as already asked", async () => {
    const seen: string[][] = [];
    await answerBugDetails(
      {
        conversationId: "c",
        history: [
          { role: "customer", text: "I found a bug" },
          { role: "assistant", text: " What were you trying to do? " },
        ],
        question: "q",
      },
      new AbortController().signal,
      (input) => {
        seen.push(input.asked);
        return Promise.resolve({
          bug_details: "pass",
          decision: "allow",
          message: null,
          run_id: "r",
          status: "completed",
        });
      }
    );
    assert.deepEqual(seen, [["What were you trying to do?"]]);
  });

  it("logs a caller's abort as cancelled, not a timeout", async (t) => {
    const lines: string[] = [];
    t.mock.method(console, "warn", (line: string) => lines.push(line));
    const abort = new Error("aborted");
    abort.name = "AbortError";
    await assert.rejects(
      answerBugDetails(
        { conversationId: "conv-2", question: "q" },
        new AbortController().signal,
        () => Promise.reject(abort)
      )
    );
    assert.equal(JSON.parse(lines[0] ?? "{}").message, "cancelled");
  });

  it("logs a failure with its reason under its own event, then rethrows", async (t) => {
    const lines: string[] = [];
    t.mock.method(console, "warn", (line: string) => lines.push(line));
    await assert.rejects(
      answerBugDetails(
        { conversationId: "conv-1", question: "q" },
        new AbortController().signal,
        () => Promise.reject(new Error("http_503"))
      ),
      { message: "http_503" }
    );
    assert.deepEqual(
      lines.map((line) => JSON.parse(line)),
      [
        {
          conversationId: "conv-1",
          event: "widget.bug_details.failed",
          message: "http_503",
        },
      ]
    );
  });
});
