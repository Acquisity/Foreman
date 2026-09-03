import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { github } from "@github-tools/eve-extension/tools";
import type { SessionAuthContext } from "eve/context";
import type { DynamicResolveContext } from "eve/tools";
import override from "../../extensions/github/tools/github.js";
import { stampRepository } from "../repository.js";

const SLACK_AUTH: SessionAuthContext = {
  attributes: {},
  authenticator: "slack",
  principalId: "user:1",
  principalType: "user",
};

const REPOSITORY_AUTH = stampRepository(
  SLACK_AUTH,
  "Acquisity/Foreman",
  "explicit"
);

const SLOT_MOVED = /@github-tools\/eve-extension.*step\.started/u;

const resolveFor = (current: SessionAuthContext) =>
  override.events["step.started"]?.(
    { type: "step.started" } as never,
    {
      channel: {},
      messages: [],
      session: { auth: { current }, id: "resolver-slot" },
    } as unknown as DynamicResolveContext
  );

/**
 * Runs `body` with the extension's `events` map replaced by one without
 * `step.started`, the shape a future release that renames the event or moves
 * the resolver would present, then puts the real map back.
 */
const withoutStepStarted = async (body: () => Promise<void>) => {
  const { events } = github;
  (github as { events: unknown }).events = {};
  try {
    await body();
  } finally {
    (github as { events: unknown }).events = events;
  }
};

describe("the GitHub tool override", () => {
  it("throws, naming the package and the key, when the resolver slot is gone", async () => {
    // `null` is how the lane gate says a lane carries no GitHub tools, so a
    // missing slot returning `null` would drop all 31 tools from every lane
    // with nothing to tell it apart from a correctly gated one. A throw loses
    // the same result but is visible in tests and `eve info` before deploy.
    await withoutStepStarted(async () => {
      await assert.rejects(
        async () => await resolveFor(REPOSITORY_AUTH),
        SLOT_MOVED
      );
    });
  });

  it("still gates a lane off with null before it looks for the slot", async () => {
    await withoutStepStarted(async () => {
      assert.equal(await resolveFor(SLACK_AUTH), null);
    });
  });
});
