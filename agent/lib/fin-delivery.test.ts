import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectFinDelivery } from "./fin-delivery.js";
import { verifiedFinContext as scope } from "./fin-investigation.fixture.js";

function fixture() {
  const conversation = {
    contacts: { contacts: [{ id: scope.contactId }], total_count: 1 },
    conversation_parts: {
      conversation_parts: [
        {
          author: { type: "bot" },
          created_at: 20,
          id: "part-1",
          part_type: "comment",
        },
      ],
      total_count: 1,
    },
    created_at: 10,
    id: scope.conversationId,
    source: {
      author: { id: scope.contactId, type: "user" },
      body: "Question",
      id: "source-1",
      url: `${scope.origin}/dashboard/${scope.organizationSlug}`,
    },
    state: "open",
    updated_at: 20,
  };
  const contact = {
    external_id: String(scope.userId),
    id: String(scope.contactId),
    workspace_id: String(scope.intercomAppId),
  };
  return {
    contact,
    conversation,
    read: async (op: string) =>
      op === "get_conversation" ? conversation : contact,
  };
}

test("only a public human reply suppresses customer delivery; later user replies do not undo takeover", async () => {
  const f = fixture();
  const initial = await inspectFinDelivery(scope, f.read);
  assert.equal(initial.humanReplied, false);
  const [part] = f.conversation.conversation_parts.conversation_parts;
  part.author.type = "admin";
  for (const type of ["note", "assignment", "close"]) {
    part.part_type = type;
    // biome-ignore lint/performance/noAwaitInLoops: sequential mutations of the same conversation fixture.
    assert.equal((await inspectFinDelivery(scope, f.read)).humanReplied, false);
  }
  part.part_type = "comment";
  assert.equal((await inspectFinDelivery(scope, f.read)).humanReplied, true);
  f.conversation.conversation_parts.conversation_parts.push({
    author: { type: "user" },
    created_at: 30,
    id: "part-2",
    part_type: "comment",
  });
  f.conversation.conversation_parts.total_count = 2;
  const after = await inspectFinDelivery(scope, f.read);
  assert.equal(after.humanReplied, true);
  assert.notEqual(after.requestKey, initial.requestKey);
});

for (const authorType of ["lead", "contact"]) {
  test(`verified ${authorType} authors retain delivery access`, async () => {
    const f = fixture();
    f.conversation.source.author.type = authorType;
    assert.equal((await inspectFinDelivery(scope, f.read)).humanReplied, false);
  });
}

test("incomplete history or changed native ownership fails closed", async () => {
  const incomplete = fixture();
  incomplete.conversation.conversation_parts.total_count = 2;
  await assert.rejects(inspectFinDelivery(scope, incomplete.read));
  const foreign = fixture();
  foreign.conversation.source.url = `${scope.origin}/dashboard/foreign`;
  await assert.rejects(inspectFinDelivery(scope, foreign.read));
  const wrongContact = fixture();
  wrongContact.contact.external_id = "other-user";
  await assert.rejects(inspectFinDelivery(scope, wrongContact.read));
});

test("retry identity ignores mutable metadata but changes for a new customer message", async () => {
  const f = fixture();
  const initial = await inspectFinDelivery(scope, f.read);
  Object.assign(f.conversation.source, {
    attachments: [{ url: "https://cdn.example/one?signature=old" }],
  });
  f.conversation.updated_at += 1;
  assert.equal(
    (await inspectFinDelivery(scope, f.read)).requestKey,
    initial.requestKey
  );
  f.conversation.conversation_parts.conversation_parts.push({
    author: { type: "user" },
    created_at: 30,
    id: "customer-2",
    part_type: "comment",
  });
  f.conversation.conversation_parts.total_count = 2;
  const changed = await inspectFinDelivery(scope, f.read);
  assert.notEqual(changed.requestKey, initial.requestKey);
  Object.assign(f.conversation.conversation_parts.conversation_parts[1], {
    attachments: [{ url: "https://cdn.example/two?signature=new" }],
    updated_at: 99,
  });
  assert.equal(
    (await inspectFinDelivery(scope, f.read)).requestKey,
    changed.requestKey
  );
});
