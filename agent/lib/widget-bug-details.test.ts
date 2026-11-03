import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUG_DETAIL_QUESTIONS, bugDetailsTurn } from "./widget-bug-details.js";

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

const turn = (reply: ReturnType<typeof scores>) =>
  bugDetailsTurn(
    {
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
      BUG_DETAIL_QUESTIONS.says_where
    );
    assert.equal(
      (await turn(scores(0.2, 0.9, 0.9))).message,
      "What were you trying to do when this happened?"
    );
  });

  it("passes when the report has all three details", async () => {
    const result = await turn(scores(0.8, 0.7, 0.6));
    assert.equal(result.bug_details, "pass");
    assert.equal(result.message, null);
  });

  it("throws without a key, so Acquisity skips to its recording step", async () => {
    await assert.rejects(
      bugDetailsTurn(
        { conversation: "x", conversationId: "c" },
        { apiKey: "", fetch: () => assert.fail("must not call Jev") }
      ),
      { message: "no_key" }
    );
  });

  it("throws on a malformed Jev answer", async () => {
    await assert.rejects(
      bugDetailsTurn(
        { conversation: "x", conversationId: "c" },
        {
          apiKey: "k",
          fetch: () =>
            Promise.resolve({
              json: () => Promise.resolve({ answers: {} }),
              ok: true,
              status: 200,
            }),
        }
      )
    );
  });
});
