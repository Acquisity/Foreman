import assert from "node:assert/strict";
import { it } from "node:test";
import { ctx, outputOf, replayProcess } from "./fixtures.js";

const { default: tool } = await import("../../tools/route_ticket.js");
const { criticRounds, triageDecisions } = await import("../triage-log.js");

it("routes a replay state change without reading live Linear", async (t) => {
  await replayProcess(t);
  t.mock.method(triageDecisions, "get", () => ({}));
  t.mock.method(criticRounds, "get", () => ({}));
  let tokens = 0;
  assert.ok(tool.execute);
  const result = await outputOf(
    tool.execute({ issue: "ENG-100", state: "Todo" }, {
      ...ctx,
      getToken: () => {
        tokens += 1;
        return Promise.reject(new Error("A replay must not read live Linear"));
      },
    } as unknown as Parameters<NonNullable<typeof tool.execute>>[1])
  );
  assert.equal(tokens, 0);
  assert.equal(result.routed, true);
  assert.equal(result.state, "Todo");
});
