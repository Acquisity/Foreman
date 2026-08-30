import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isStopRequest } from "./slack-stop.js";

describe("isStopRequest", () => {
  it("accepts the bare words stop and cancel", () => {
    assert.equal(isStopRequest("stop"), true);
    assert.equal(isStopRequest("cancel"), true);
  });

  it("ignores case and surrounding whitespace", () => {
    assert.equal(isStopRequest("STOP"), true);
    assert.equal(isStopRequest("  Cancel  "), true);
    assert.equal(isStopRequest("\nStop\n"), true);
  });

  it("accepts terminal punctuation", () => {
    assert.equal(isStopRequest("stop."), true);
    assert.equal(isStopRequest("cancel!"), true);
    assert.equal(isStopRequest("stop?!"), true);
  });

  it("accepts an optional bot mention before or after the word", () => {
    assert.equal(isStopRequest("<@U123ABC> stop"), true);
    assert.equal(isStopRequest("stop <@U123ABC>"), true);
    assert.equal(isStopRequest("<@U123ABC|foreman> cancel"), true);
    assert.equal(isStopRequest("<@U1> <@U2> stop."), true);
  });

  it("accepts punctuation after a trailing mention", () => {
    assert.equal(isStopRequest("stop <@U123>!"), true);
    assert.equal(isStopRequest("cancel <@U123>."), true);
    assert.equal(isStopRequest("<@U1> stop! <@U2>."), true);
  });

  it("rejects longer requests", () => {
    assert.equal(isStopRequest("stop the deploy"), false);
    assert.equal(isStopRequest("cancel that please"), false);
    assert.equal(isStopRequest("please stop."), false);
    assert.equal(isStopRequest("stop and then cancel"), false);
  });

  it("rejects words that merely contain stop or cancel", () => {
    assert.equal(isStopRequest("stops"), false);
    assert.equal(isStopRequest("stopping"), false);
    assert.equal(isStopRequest("cancelled"), false);
    assert.equal(isStopRequest("unstoppable"), false);
  });

  it("rejects a mention with no stop word", () => {
    assert.equal(isStopRequest("<@U123ABC>"), false);
  });

  it("rejects empty and whitespace-only input", () => {
    assert.equal(isStopRequest(""), false);
    assert.equal(isStopRequest("   \n  "), false);
  });

  it("rejects multiline requests", () => {
    assert.equal(isStopRequest("stop\nplease"), false);
  });

  it("rejects input beyond the length bound even when it would otherwise match", () => {
    const paddedButValid = `${"<@U1> ".repeat(40)}stop`;
    assert.equal(paddedButValid.length > 200, true);
    assert.equal(isStopRequest(paddedButValid), false);
  });

  it("pins the inclusive 200-character boundary with otherwise-valid input", () => {
    const exactly200 = `stop${"!".repeat(196)}`;
    const exactly201 = `stop${"!".repeat(197)}`;
    assert.equal(exactly200.length, 200);
    assert.equal(exactly201.length, 201);
    assert.equal(isStopRequest(exactly200), true);
    assert.equal(isStopRequest(exactly201), false);
  });

  it("rejects a mention embedded inside the word", () => {
    assert.equal(isStopRequest("st<@U123>op"), false);
    assert.equal(isStopRequest("s<@U1>top"), false);
    assert.equal(isStopRequest("<@U1>stop<@U2> deploy"), false);
  });
});
