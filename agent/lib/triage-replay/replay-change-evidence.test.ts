import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTriage } from "../jev-decisions.js";
import {
  saveInvestigationDocument,
  ticketDocumentUrls,
} from "../linear-api.js";
import {
  bugAnswers,
  pick,
  RECORDED_CHANGE,
  triageInput,
} from "../triage-fixtures.js";
import {
  ARCHIVE_URL,
  KEY,
  lists,
  replayClient,
  triageCase,
} from "./fixtures.js";
import { seedReplayState, urlOf } from "./store.js";

const explained = bugAnswers({
  classification: pick("user_error"),
  path: pick("Resolved by triage"),
});

describe("replayed change evidence (CodeRabbit 6)", () => {
  it("counts the replay's own investigation document as a recorded change, and never the ticket's link", async () => {
    const state = seedReplayState(triageCase, {
      archiveUrl: ARCHIVE_URL,
      caseKey: KEY,
      lists,
      stamp: { foremanCommit: "f".repeat(40), startedAt: "2026-10-28" },
    });
    const client = replayClient(state);
    const saved = await saveInvestigationDocument(
      {
        content: "Reconnected the inbox.",
        issue: triageCase.id,
        lane: "triage",
      },
      { client }
    );
    const ticketDocuments = await ticketDocumentUrls(triageCase.id, { client });
    assert.deepEqual(ticketDocuments, [saved.url]);
    const decide = (recordedAt: string) =>
      resolveTriage(
        triageInput({
          changeMade: { ...RECORDED_CHANGE, recordedAt },
          identifier: triageCase.id,
          ticketDocuments,
        }),
        explained
      );
    const counted = decide(saved.url);
    assert.ok(counted.outcome === "route");
    assert.equal(counted.route.state, "Done");
    const ticketLink = decide(urlOf(triageCase.id));
    assert.ok(ticketLink.outcome === "route");
    assert.equal(ticketLink.route.state, "Canceled");
  });
});
