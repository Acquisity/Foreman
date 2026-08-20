import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionAuthContext } from "eve/context";
import type { ApprovalContext } from "eve/tools";
import {
  stampAutonomous,
  stampIntakeOnly,
  stampTrusted,
  UNATTENDED_ATTRIBUTE,
} from "../trust.js";
import {
  deliveryPolicy,
  denyUnattendedWrites,
  modelSwapPolicy,
  repositoryKnowledgePolicy,
  userPreferencesDeletionPolicy,
} from "./approval.js";

const auth: SessionAuthContext = {
  attributes: {},
  authenticator: "slack",
  principalId: "user:1",
  principalType: "user",
};

const scheduleAppAuth: SessionAuthContext = {
  attributes: {},
  authenticator: "app",
  principalId: "eve:app",
  principalType: "runtime",
};

const unattendedAuth: SessionAuthContext = {
  ...auth,
  attributes: { [UNATTENDED_ATTRIBUTE]: "true" },
};

const approvalFor = (current: SessionAuthContext, toolName = "push_branch") =>
  ({
    session: { auth: { current } },
    toolName,
  }) as unknown as ApprovalContext;

describe("deliveryPolicy", () => {
  it("parks an untrusted attended caller on an approval card", () => {
    assert.equal(deliveryPolicy(approvalFor(auth)), "user-approval");
  });

  it("lets a trusted caller publish without a card", () => {
    assert.equal(
      deliveryPolicy(approvalFor(stampTrusted(auth))),
      "not-applicable"
    );
  });

  it("denies an autonomous principal", () => {
    const status = deliveryPolicy(approvalFor(stampAutonomous(auth, 123)));
    assert.equal(typeof status === "object" && status.type, "denied");
  });

  it("denies a schedule dispatched under a real user, even when trusted", () => {
    const status = deliveryPolicy(approvalFor(stampTrusted(unattendedAuth)));
    assert.equal(typeof status === "object" && status.type, "denied");
  });

  it("denies an intake-only session even when trusted", () => {
    const status = deliveryPolicy(
      approvalFor(stampIntakeOnly(stampTrusted(auth)))
    );
    assert.equal(typeof status === "object" && status.type, "denied");
  });

  it("lets a schedule-app principal publish without a card", () => {
    assert.equal(
      deliveryPolicy(approvalFor(scheduleAppAuth)),
      "not-applicable"
    );
  });
});

describe("repositoryKnowledgePolicy", () => {
  it("lets a trusted caller write without a card", () => {
    assert.equal(
      repositoryKnowledgePolicy(approvalFor(stampTrusted(auth))),
      "not-applicable"
    );
  });

  it("parks an untrusted attended caller on an approval card", () => {
    assert.equal(repositoryKnowledgePolicy(approvalFor(auth)), "user-approval");
  });

  it("denies an autonomous principal", () => {
    const status = repositoryKnowledgePolicy(
      approvalFor(stampAutonomous(auth, 123))
    );
    assert.equal(typeof status === "object" && status.type, "denied");
  });
});

describe("modelSwapPolicy", () => {
  it("lets a trusted caller write without a card", () => {
    assert.equal(
      modelSwapPolicy(approvalFor(stampTrusted(auth))),
      "not-applicable"
    );
  });

  it("parks an untrusted attended caller on an approval card", () => {
    assert.equal(modelSwapPolicy(approvalFor(auth)), "user-approval");
  });

  it("denies an autonomous principal", () => {
    const status = modelSwapPolicy(approvalFor(stampAutonomous(auth, 123)));
    assert.equal(typeof status === "object" && status.type, "denied");
  });
});

describe("denyUnattendedWrites", () => {
  const policy = denyUnattendedWrites("Supermemory", ["add_memory"]);

  it("denies an autonomous write", () => {
    const status = policy(
      approvalFor(stampAutonomous(auth, 123), "supermemory__add_memory")
    );
    assert.equal(typeof status === "object" && status.type, "denied");
  });

  it("leaves an autonomous non-write ungated", () => {
    assert.equal(
      policy(
        approvalFor(stampAutonomous(auth, 123), "supermemory__search_memory")
      ),
      "not-applicable"
    );
  });

  it("leaves an attended write ungated", () => {
    assert.equal(
      policy(approvalFor(auth, "supermemory__add_memory")),
      "not-applicable"
    );
  });
});

describe("userPreferencesDeletionPolicy", () => {
  it("denies a schedule dispatched under a real user", () => {
    const status = userPreferencesDeletionPolicy(approvalFor(unattendedAuth));
    assert.equal(typeof status === "object" && status.type, "denied");
  });

  it("denies an autonomous run", () => {
    const status = userPreferencesDeletionPolicy(
      approvalFor(stampAutonomous(auth, 7))
    );
    assert.equal(typeof status === "object" && status.type, "denied");
  });

  it("lets an attended user clear their own preferences", () => {
    for (const current of [auth, stampTrusted(auth)]) {
      assert.equal(
        userPreferencesDeletionPolicy(approvalFor(current)),
        "not-applicable"
      );
    }
  });
});
