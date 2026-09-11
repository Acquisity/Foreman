import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RouteHandlerArgs } from "eve/channels";
import type { SessionAuthContext } from "eve/context";
import channel from "../../channels/github.js";
import { repositoryFromAuth } from "../repository.js";
import {
  canUseInvestigationMemory,
  isTrusted,
  isUnattended,
} from "../trust.js";
import { githubCredentials } from "./credentials.js";

const sender = { id: 123, login: "reviewer", type: "User" };
const repository = {
  full_name: "Acquisity/Foreman",
  id: 456,
  name: "Foreman",
  owner: { login: "Acquisity" },
};

describe("GitHub explicit mention intake", () => {
  it("ignores automatic events and only dispatches trusted human mentions", async (t) => {
    const previous = process.env.FOREMAN_BOT_NAME;
    process.env.FOREMAN_BOT_NAME = "foreman-preview";
    t.after(() => {
      if (previous === undefined) {
        delete process.env.FOREMAN_BOT_NAME;
      } else {
        process.env.FOREMAN_BOT_NAME = previous;
      }
    });
    // Only signature verification is stubbed. The authored channel route,
    // native webhook parser and Foreman's mention/auth gate run together.
    assert.ok(githubCredentials.webhookVerifier);
    const credentials = githubCredentials as Required<
      Pick<typeof githubCredentials, "webhookVerifier">
    >;
    t.mock.method(credentials, "webhookVerifier", () => Promise.resolve(true));
    const [route] = channel.routes;
    assert.ok(route && route.method === "POST");
    const sent: { auth: SessionAuthContext }[] = [];
    const pending: Promise<unknown>[] = [];
    const context = {
      from: () => ({
        send: (_message: string, options: { auth: SessionAuthContext }) => {
          sent.push(options);
          return Promise.resolve();
        },
      }),
      waitUntil: (task: Promise<unknown>) => pending.push(task),
    } as unknown as RouteHandlerArgs;
    const deliver = async (event: string, payload: Record<string, unknown>) => {
      const response = await route.handler(
        new Request("https://foreman.test/eve/v1/github", {
          body: JSON.stringify({ repository, sender, ...payload }),
          headers: {
            "content-type": "application/json",
            "x-github-delivery": "test-delivery",
            "x-github-event": event,
          },
          method: "POST",
        }),
        context
      );
      assert.equal(response.status, 200);
      await Promise.all(pending.splice(0));
      return response.json();
    };

    for (const [event, payload] of [
      [
        "issues",
        {
          action: "labeled",
          issue: { labels: [{ name: "factory" }], number: 7 },
        },
      ],
      ["pull_request", { action: "opened", pull_request: { number: 7 } }],
      [
        "pull_request",
        {
          action: "synchronize",
          pull_request: {
            head: { ref: "foreman/fix", repo: repository },
            number: 7,
          },
        },
      ],
      [
        "check_suite",
        {
          action: "completed",
          check_suite: {
            conclusion: "failure",
            head_branch: "foreman/fix",
            id: 9,
            pull_requests: [{ number: 7 }],
          },
        },
      ],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: each dispatch checks the same captured stream before the next event.
      assert.deepEqual(await deliver(event, payload), {
        ignored: true,
        ok: true,
      });
    }
    assert.equal(sent.length, 0);

    const comment = (body: string, association: string, user = sender) => ({
      action: "created",
      comment: { author_association: association, body, id: 42, user },
      issue: { number: 7 },
    });
    for (const payload of [
      comment("Please fix this", "OWNER"),
      comment("@foreman-preview please fix this", "CONTRIBUTOR"),
      comment("@foreman-preview please fix this", "NONE"),
      comment("@foreman-preview please fix this", "OWNER", {
        ...sender,
        type: "Bot",
      }),
      comment("@foreman-preview please fix this", "OWNER", {
        ...sender,
        login: "foreman-preview[bot]",
      }),
      comment("<!-- eve:github:reply --> @foreman-preview", "OWNER"),
      comment("@foreman-preview-other please fix this", "OWNER"),
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential events exercise the same channel and captured stream.
      await deliver("issue_comment", payload);
      assert.equal(sent.length, 0);
    }
    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential events exercise the same channel and captured stream.
      await deliver(
        "issue_comment",
        comment(
          "@foreman-preview inspect https://github.com/Other/Repo",
          association
        )
      );
    }
    assert.equal(sent.length, 3);
    for (const { auth } of sent) {
      assert.equal(auth.principalId, "github:123");
      assert.ok(isTrusted(auth));
      assert.equal(isUnattended(auth), false);
      assert.equal(canUseInvestigationMemory(auth), false);
      assert.deepEqual(repositoryFromAuth(auth), {
        owner: "Acquisity",
        repo: "Foreman",
        slug: "Acquisity/Foreman",
        source: "github-webhook",
      });
    }
  });
});
