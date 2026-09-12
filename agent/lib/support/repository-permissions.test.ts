import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionAuthContext } from "eve/context";
import type { DynamicResolveContext } from "eve/tools";
import type { ApprovalContext } from "eve/tools/approval";
import checkout from "../../tools/checkout_branch.js";
import push from "../../tools/push_branch.js";
import readKnowledge from "../../tools/read_repository_knowledge.js";
import update from "../../tools/update_repository_knowledge.js";
import {
  deliveryPolicy,
  repositoryKnowledgePolicy,
} from "../github/approval.js";
import { stampRepository } from "../repository.js";
import { supportAuth } from "./auth.js";

const app: SessionAuthContext = {
  attributes: {},
  authenticator: "app",
  principalId: "eve:app",
  principalType: "runtime",
};
const current = stampRepository(app, "Acquisity/Acquisity", "explicit");
const initiator = supportAuth(app, {
  conversation: "123456",
  lease: "7bd819bb-af11-49c8-b11f-4c0d608e9244",
  thread: "1750000000.000001",
});
const context = {
  session: { auth: { current, initiator } },
} as DynamicResolveContext;

test("support initiator hides every repository write resolver while preserving reads", () => {
  for (const tool of [checkout, push, update]) {
    assert.equal(tool.events["step.started"]?.({} as never, context), null);
    assert.ok(
      tool.events["step.started"]?.({} as never, {
        ...context,
        session: { ...context.session, auth: { current, initiator: app } },
      })
    );
  }
  for (const tool of [readKnowledge]) {
    assert.ok(tool.events["step.started"]?.({} as never, context));
  }
});

test("shared write approval cannot lose unattended or intake restrictions on the app identity", () => {
  for (const policy of [deliveryPolicy, repositoryKnowledgePolicy]) {
    const result = policy(context as unknown as ApprovalContext);
    assert.equal(typeof result === "object" && result.type, "denied");
  }
});
