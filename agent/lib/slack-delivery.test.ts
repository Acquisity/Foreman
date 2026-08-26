import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SlackEventContext } from "eve/channels/slack";
import type { SessionAuthContext, SessionContext } from "eve/context";
import {
  type ActionAttestation,
  decideSlackDelivery,
  findActionStatements,
  type GateStore,
  gateForTurn,
  recordAttestation,
  recordSucceededTool,
  SLACK_DELIVERY_FALLBACK,
  type SlackDeliveryGate,
  slackDeliveryEvents,
} from "./slack-delivery.js";
import { isIntakeOnly, stampIntakeOnly } from "./trust.js";

const REBOOK_PROMISE =
  "Happy to rebook the affected calls on the correct calendar if you share which ones.";
const REBOOK_TRANSFER =
  "Support should review and rebook the affected appointments.";
const PARAPHRASES = [
  "I'll rebook them.",
  "We can fix those for you.",
  "Support can recover these.",
  "I'll monitor this.",
  "We'll update the ticket.",
  "The engineering team will follow up once the fix lands.",
  "Let me reset the calendar link for that workspace.",
  "I'm going to escalate this to our devs.",
];
const SAFE_WORDING =
  "No safe rebooking path was confirmed during this investigation. Whether the affected appointments can be recovered remains unresolved.";
const FACTUAL =
  "The calls were cancelled by the calendar provider at 09:14 when the connected account's token expired. The campaign was marked Completed while 256 of 535 leads were still uncontacted. I can confirm the workspace has two connected calendars. Reconnect the calendar under Settings > Integrations to resume booking.";
const NEGATED =
  "We could not recover the original booking records, and I cannot rebook them from here.";

const noGate = { attestations: [], succeededTools: [] };

describe("findActionStatements", () => {
  it("flags the ENG-13108 promise and its transfer to Support", () => {
    assert.deepEqual(findActionStatements(REBOOK_PROMISE), [REBOOK_PROMISE]);
    assert.deepEqual(findActionStatements(REBOOK_TRANSFER), [REBOOK_TRANSFER]);
  });

  it("flags every paraphrase and completed-action claim", () => {
    for (const sentence of PARAPHRASES) {
      assert.equal(findActionStatements(sentence).length, 1, sentence);
    }
    assert.equal(findActionStatements("The ticket was updated.").length, 1);
    assert.equal(findActionStatements("I've updated the ticket.").length, 1);
  });

  it("leaves factual findings, customer steps, negations, and safe wording alone", () => {
    for (const text of [FACTUAL, NEGATED, SAFE_WORDING]) {
      assert.deepEqual(findActionStatements(text), [], text);
    }
  });

  it("returns only the offending sentences of a mixed message", () => {
    const found = findActionStatements(`${FACTUAL}\n\n${REBOOK_PROMISE}`);
    assert.deepEqual(found, [REBOOK_PROMISE]);
  });
});

describe("decideSlackDelivery", () => {
  it("rejects both ENG-13108 phrasings and every paraphrase without an attestation", () => {
    for (const text of [REBOOK_PROMISE, REBOOK_TRANSFER, ...PARAPHRASES]) {
      assert.deepEqual(
        decideSlackDelivery(text, noGate),
        { allowed: false, reason: "unattested-action" },
        text
      );
    }
  });

  it("posts non-action prose and the safe wording unchanged", () => {
    for (const text of [FACTUAL, SAFE_WORDING, NEGATED]) {
      assert.deepEqual(decideSlackDelivery(text, noGate), {
        allowed: true,
        message: text,
      });
    }
  });

  it("allows a completed claim only with a successful result from the named tool", () => {
    const sentence = "The ticket was updated with these findings.";
    const attestations: ActionAttestation[] = [
      { sentence, state: "completed", toolName: "linear__save_issue" },
    ];
    assert.equal(
      decideSlackDelivery(sentence, {
        attestations,
        succeededTools: ["linear__save_issue"],
      }).allowed,
      true
    );
    assert.deepEqual(
      decideSlackDelivery(sentence, { attestations, succeededTools: [] }),
      { allowed: false, reason: "unproven-completion" }
    );
    assert.deepEqual(
      decideSlackDelivery(sentence, {
        attestations,
        succeededTools: ["linear__get_issue"],
      }),
      { allowed: false, reason: "unproven-completion" }
    );
  });

  it("allows a verified available option only when the sentence names its owner", () => {
    const sentence =
      "Support can rebook the two calls from the Bookings page once the calendar is reconnected; nothing has been rebooked yet.";
    const attest = (owner: string) => [
      { owner, sentence, state: "available" as const },
    ];
    assert.equal(
      decideSlackDelivery(sentence, {
        attestations: attest("Support"),
        succeededTools: [],
      }).allowed,
      true
    );
    assert.deepEqual(
      decideSlackDelivery(sentence, {
        attestations: attest("the workspace admin"),
        succeededTools: [],
      }),
      { allowed: false, reason: "owner-not-named" }
    );
    assert.deepEqual(
      decideSlackDelivery("We can rebook the two calls for you.", {
        attestations: [
          {
            owner: "we",
            sentence: "We can rebook the two calls for you.",
            state: "available",
          },
        ],
        succeededTools: [],
      }),
      { allowed: false, reason: "owner-not-named" }
    );
  });

  it("does not let one attestation cover a different sentence", () => {
    const decision = decideSlackDelivery(
      `${REBOOK_PROMISE} ${REBOOK_TRANSFER}`,
      {
        attestations: [
          { owner: "Support", sentence: REBOOK_TRANSFER, state: "available" },
        ],
        succeededTools: [],
      }
    );
    assert.deepEqual(decision, {
      allowed: false,
      reason: "unattested-action",
    });
  });
});

const memoryStore = (turnId = "turn_0"): GateStore => {
  let value: SlackDeliveryGate = {
    attestations: [],
    succeededTools: [],
    turnId,
  };
  return {
    get: () => value,
    update(fn) {
      value = fn(value);
    },
  };
};

describe("turn-scoped gate state", () => {
  it("discards attestations and results left by an earlier turn", () => {
    const store = memoryStore("turn_0");
    recordSucceededTool(store, "turn_0", "linear__save_issue");
    recordAttestation(store, "turn_0", {
      sentence: "The ticket was updated.",
      state: "completed",
      toolName: "linear__save_issue",
    });
    assert.equal(store.get().succeededTools.length, 1);
    assert.deepEqual(gateForTurn(store.get(), "turn_1"), {
      attestations: [],
      succeededTools: [],
      turnId: "turn_1",
    });
    recordSucceededTool(store, "turn_1", "linear__get_issue");
    assert.deepEqual(store.get(), {
      attestations: [],
      succeededTools: ["linear__get_issue"],
      turnId: "turn_1",
    });
  });
});

const baseAuth: SessionAuthContext = {
  attributes: {},
  authenticator: "slack",
  principalId: "user:1",
  principalType: "user",
};

const harness = (auth: SessionAuthContext) => {
  const posts: unknown[] = [];
  let typing = 0;
  const channel = {
    thread: {
      post: (message: unknown) => {
        posts.push(message);
        return Promise.resolve({ id: "1" });
      },
      startTyping: () => {
        typing += 1;
        return Promise.resolve();
      },
    },
  } as unknown as SlackEventContext;
  const ctx = {
    session: {
      auth: { current: auth },
      id: "session_1",
      turn: { id: "turn_0" },
    },
  } as unknown as SessionContext;
  const store = memoryStore();
  const events = slackDeliveryEvents(store, isIntakeOnly);
  const completed = (
    message: string | null,
    finishReason: "stop" | "tool-calls" = "stop"
  ) =>
    events["message.completed"]?.(
      { finishReason, message, sequence: 0, stepIndex: 0, turnId: "turn_0" },
      channel,
      ctx
    );
  const result = (toolName: string, isError?: boolean) =>
    events["action.result"]?.(
      {
        result: {
          callId: "c1",
          isError,
          kind: "tool-result",
          output: {},
          toolName,
        },
        sequence: 0,
        status: "completed",
        stepIndex: 0,
        turnId: "turn_0",
      },
      channel,
      ctx
    );
  return { completed, posts, result, store, typing: () => typing };
};

describe("Slack channel delivery events", () => {
  const intake = stampIntakeOnly(baseAuth);

  it("posts a safe intake reply exactly once and unchanged", async () => {
    const h = harness(intake);
    await h.completed(FACTUAL);
    assert.deepEqual(h.posts, [FACTUAL]);
  });

  it("replaces the ENG-13108 promise and its Support transfer with the fallback", async () => {
    const h = harness(intake);
    await h.completed(REBOOK_PROMISE);
    await h.completed(REBOOK_TRANSFER);
    assert.deepEqual(h.posts, [
      SLACK_DELIVERY_FALLBACK,
      SLACK_DELIVERY_FALLBACK,
    ]);
  });

  it("never posts tool-call narration", async () => {
    const h = harness(intake);
    await h.completed("Let me update the ticket first.", "tool-calls");
    assert.deepEqual(h.posts, []);
  });

  it("resets typing without posting on blank or empty-delivery output", async () => {
    const h = harness(intake);
    await h.completed(null);
    await h.completed("   ");
    await h.completed("<eve-empty-delivery/>");
    assert.deepEqual(h.posts, []);
    assert.equal(h.typing(), 3);
  });

  it("reports a completed action only after the channel saw that tool succeed", async () => {
    const sentence = "The ticket was updated with the findings.";
    const attest = (h: ReturnType<typeof harness>) =>
      recordAttestation(h.store, "turn_0", {
        sentence,
        state: "completed",
        toolName: "linear__save_issue",
      });

    const failed = harness(intake);
    await failed.result("linear__save_issue", true);
    attest(failed);
    await failed.completed(sentence);
    assert.deepEqual(failed.posts, [SLACK_DELIVERY_FALLBACK]);

    const succeeded = harness(intake);
    await succeeded.result("linear__save_issue");
    attest(succeeded);
    await succeeded.completed(sentence);
    assert.deepEqual(succeeded.posts, [sentence]);
  });

  it("posts a verified available option with its named owner", async () => {
    const h = harness(intake);
    recordAttestation(h.store, "turn_0", {
      owner: "Support",
      sentence: REBOOK_TRANSFER,
      state: "available",
    });
    await h.completed(`${SAFE_WORDING} ${REBOOK_TRANSFER}`);
    assert.deepEqual(h.posts, [`${SAFE_WORDING} ${REBOOK_TRANSFER}`]);
  });

  it("leaves developer channels ungated", async () => {
    const h = harness(baseAuth);
    await h.completed("Pushed the branch and I've opened the pull request.");
    assert.deepEqual(h.posts, [
      "Pushed the branch and I've opened the pull request.",
    ]);
  });
});
