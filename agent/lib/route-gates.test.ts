import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keepChatsOnCase, type LinearRead } from "./route-gates.js";

process.env.ACQUISITY_ORIGIN ??= "https://app.acquisity.ai";

const CHAT_STAYS = /chat link belongs on SAN-320 only/u;

const CHAT = {
  title: "Support chat",
  url: "https://app.acquisity.ai/dashboard/admin/support?conversation=922677ed-d6aa-45d3-a0fc-3246a845cadb",
};
const PR = {
  title: "fix: retries",
  url: "https://github.com/Acquisity/Acquisity/pull/1",
};

/** Linear as measured on SAN-320: the join moved the case's chat link onto the match. */
const linearAfterJoin = (fail?: string, refuse?: string) => {
  const issues: Record<string, { id: string; title: string; url: string }[]> = {
    "SAN-319": [
      { id: "a-pr", ...PR },
      { id: "a-moved", ...CHAT },
    ],
    "SAN-320": [],
  };
  const calls: string[] = [];
  const linear: LinearRead = async (_query, name, variables) => {
    calls.push(name);
    if (name === fail) {
      throw new Error("HTTP 500");
    }
    if (name === "RouteChatLinks") {
      const nodes = issues[variables.id] ?? [];
      return (await Promise.resolve({
        issue: { attachments: { nodes } },
      })) as never;
    }
    if (name === refuse) {
      return (
        name === "RouteChatLink"
          ? { attachmentLinkURL: { success: false } }
          : { attachmentDelete: { success: false } }
      ) as never;
    }
    if (name === "RouteChatLink") {
      issues[variables.issueId]?.push({
        id: "a-relinked",
        title: variables.title ?? "",
        url: variables.url ?? "",
      });
      return { attachmentLinkURL: { success: true } } as never;
    }
    for (const nodes of Object.values(issues)) {
      const at = nodes.findIndex((node) => node.id === variables.id);
      if (at >= 0) {
        nodes.splice(at, 1);
      }
    }
    return { attachmentDelete: { success: true } } as never;
  };
  return { calls, issues, linear };
};

describe("keepChatsOnCase", () => {
  it("puts the case's chat link back on the case and takes the moved copy off the match", async () => {
    const fake = linearAfterJoin();
    const warning = await keepChatsOnCase(
      "SAN-320",
      "SAN-319",
      [CHAT],
      fake.linear
    );
    assert.equal(warning, null);
    assert.deepEqual(
      fake.issues["SAN-320"].map((a) => a.url),
      [CHAT.url]
    );
    assert.deepEqual(
      fake.issues["SAN-319"].map((a) => a.url),
      [PR.url]
    );
  });

  it("relinks before it deletes, and warns without throwing when a write fails", async () => {
    const fake = linearAfterJoin("RouteChatUnlink");
    const warning = await keepChatsOnCase(
      "SAN-320",
      "SAN-319",
      [CHAT],
      fake.linear
    );
    assert.match(warning ?? "", CHAT_STAYS);
    assert.deepEqual(fake.calls, [
      "RouteChatLinks",
      "RouteChatLink",
      "RouteChatLinks",
      "RouteChatUnlink",
    ]);
    assert.deepEqual(
      fake.issues["SAN-320"].map((a) => a.url),
      [CHAT.url]
    );
  });

  it("keeps the moved copy when Linear refuses the relink, and warns when it refuses the delete", async () => {
    const relink = linearAfterJoin(undefined, "RouteChatLink");
    assert.match(
      (await keepChatsOnCase("SAN-320", "SAN-319", [CHAT], relink.linear)) ??
        "",
      CHAT_STAYS
    );
    assert.ok(!relink.calls.includes("RouteChatUnlink"));
    assert.deepEqual(
      relink.issues["SAN-319"].map((a) => a.url),
      [PR.url, CHAT.url]
    );
    const unlink = linearAfterJoin(undefined, "RouteChatUnlink");
    assert.match(
      (await keepChatsOnCase("SAN-320", "SAN-319", [CHAT], unlink.linear)) ??
        "",
      CHAT_STAYS
    );
  });
});
