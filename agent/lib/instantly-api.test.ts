import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InstantlyApiError,
  listInstantlySubworkspaces,
  readInstantlySubworkspace,
} from "./instantly-api.js";

const ADMIN_ID = "24f5c554-bf6c-4f51-a909-d25d9617cff9";
const MEMBER_ID = "019e050a-b40f-7d29-ba21-67bfd9d99788";
const WORKSPACE_ID = "e05cbe7b-67db-4b07-b712-46b9365dc83f";
const SECOND_WORKSPACE_ID = "019e050a-b40f-7d29-ba21-67c1bc8062b2";
const AMBIGUOUS_WORKSPACE = /More than one accepted Instantly subworkspace/u;
const NO_ACCEPTED_WORKSPACE = /No accepted Instantly subworkspace/u;
const REPEATED_CURSOR = /repeated a Workspace Group pagination cursor/u;

const member = (
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> => ({
  admin_workspace_id: ADMIN_ID,
  admin_workspace_name: "IBG",
  id: MEMBER_ID,
  status: "accepted",
  sub_workspace_id: WORKSPACE_ID,
  sub_workspace_name: "Rick Livingston's Workspace",
  ...overrides,
});

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Promise<Response> =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json", ...headers },
      status,
    })
  );

describe("Instantly Workspace Group", () => {
  it("follows every page and returns accepted subworkspaces with admin provenance", async () => {
    const calls: Array<{ init?: RequestInit; url: string }> = [];
    const fetchStub: typeof fetch = (url, init) => {
      calls.push({ init, url: String(url) });
      return String(url).includes("starting_after=next-page")
        ? json({
            items: [
              member({
                id: "019e050a-ef7d-7986-ae6a-d1b767704534",
                status: "pending",
                sub_workspace_id: "019e050a-ef7d-7986-ae6a-d1b767704535",
                sub_workspace_name: "Pending Workspace",
              }),
              member({
                id: "019e050a-ef7d-7986-ae6a-d1b767704536",
                sub_workspace_id: SECOND_WORKSPACE_ID,
                sub_workspace_name: "Second Workspace",
              }),
            ],
          })
        : json({ items: [member()], next_starting_after: "next-page" });
    };

    const result = await listInstantlySubworkspaces("secret-key", {
      fetch: fetchStub,
    });

    assert.deepEqual(result, {
      adminWorkspace: { id: ADMIN_ID, name: "IBG" },
      excludedMemberships: { pending: 1, rejected: 0 },
      subworkspaces: [
        { id: WORKSPACE_ID, name: "Rick Livingston's Workspace" },
        { id: SECOND_WORKSPACE_ID, name: "Second Workspace" },
      ],
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url.endsWith("?limit=100"), true);
    assert.equal(
      calls[1]?.url.endsWith("?limit=100&starting_after=next-page"),
      true
    );
    for (const { init } of calls) {
      assert.equal(init?.method, "GET");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Authorization"), "Bearer secret-key");
      assert.equal(headers.has("x-as-workspace"), false);
    }
  });

  it("does not expose provider error bodies", async () => {
    await assert.rejects(
      listInstantlySubworkspaces("secret-key", {
        fetch: () => json({ detail: "secret provider detail" }, 401),
      }),
      (error) => {
        assert.ok(error instanceof InstantlyApiError);
        assert.equal(error.status, 401);
        assert.equal(error.kind, "authorization");
        assert.equal(error.message.includes("secret provider detail"), false);
        return true;
      }
    );
  });

  it("retries a short rate limit and respects the retry hint", async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await listInstantlySubworkspaces("secret-key", {
      fetch: () => {
        calls += 1;
        return calls === 1
          ? json({}, 429, { "Retry-After": "1" })
          : json({ items: [member()] });
      },
      sleep: (milliseconds) => {
        delays.push(milliseconds);
        return Promise.resolve();
      },
    });

    assert.equal(calls, 2);
    assert.deepEqual(delays, [1000]);
    assert.equal(result.subworkspaces.length, 1);
  });

  it("returns a safe error instead of sleeping through a long rate limit", async () => {
    await assert.rejects(
      listInstantlySubworkspaces("secret-key", {
        fetch: () => json({}, 429, { "Retry-After": "60" }),
      }),
      (error) => {
        assert.ok(error instanceof InstantlyApiError);
        assert.equal(error.kind, "rate-limited");
        assert.equal(error.retryAfterSeconds, 60);
        return true;
      }
    );
  });

  it("rejects a repeated cursor instead of looping", async () => {
    await assert.rejects(
      listInstantlySubworkspaces("secret-key", {
        fetch: () =>
          json({ items: [member()], next_starting_after: "same-cursor" }),
      }),
      REPEATED_CURSOR
    );
  });
});

describe("Instantly subworkspace reads", () => {
  it("finds an authoritative ID beyond page one and propagates the resource cursor", async () => {
    const calls: Array<{ init?: RequestInit; url: string }> = [];
    const fetchStub: typeof fetch = (url, init) => {
      calls.push({ init, url: String(url) });
      const calledUrl = String(url);
      if (calledUrl.includes("starting_after=group-page-two")) {
        return json({ items: [member()] });
      }
      if (calledUrl.includes("workspace-group-members")) {
        return json({
          items: [
            member({
              id: "019e050a-ef7d-7986-ae6a-d1b767704536",
              sub_workspace_id: SECOND_WORKSPACE_ID,
              sub_workspace_name: "First-page Workspace",
            }),
          ],
          next_starting_after: "group-page-two",
        });
      }
      return json({
        items: [
          {
            id: "campaign-1",
            name: "Campaign",
            provider_credentials: { password: "private" },
            smtp_password: "private",
          },
        ],
        next_starting_after: "next-resource",
      });
    };

    const result = await readInstantlySubworkspace(
      "secret-key",
      { id: WORKSPACE_ID },
      "campaigns",
      { limit: 50, search: "Renewals", startingAfter: "campaign-cursor" },
      { fetch: fetchStub }
    );

    assert.deepEqual(result, {
      items: [{ id: "campaign-1", name: "Campaign" }],
      nextStartingAfter: "next-resource",
      resource: "campaigns",
      workspace: { id: WORKSPACE_ID, name: "Rick Livingston's Workspace" },
    });
    assert.equal(calls.length, 3);
    assert.equal(
      calls[2]?.url.endsWith(
        "/campaigns?limit=50&starting_after=campaign-cursor&search=Renewals"
      ),
      true
    );
    const headers = new Headers(calls[2]?.init?.headers);
    assert.equal(headers.get("Authorization"), "Bearer secret-key");
    assert.equal(headers.get("x-as-workspace"), WORKSPACE_ID);
  });

  it("normalizes an exact workspace name and rejects ambiguous matches", async () => {
    const result = await readInstantlySubworkspace(
      "secret-key",
      { name: "  RICK   LIVINGSTON'S workspace " },
      "accounts",
      {},
      {
        fetch: (url) =>
          String(url).includes("workspace-group-members")
            ? json({ items: [member()] })
            : json({ items: [] }),
      }
    );
    assert.equal(result.workspace.id, WORKSPACE_ID);

    await assert.rejects(
      readInstantlySubworkspace(
        "secret-key",
        { name: "Duplicate" },
        "accounts",
        {},
        {
          fetch: () =>
            json({
              items: [
                member({ sub_workspace_name: "Duplicate" }),
                member({
                  id: "019e050a-ef7d-7986-ae6a-d1b767704536",
                  sub_workspace_id: SECOND_WORKSPACE_ID,
                  sub_workspace_name: " duplicate ",
                }),
              ],
            }),
        }
      ),
      AMBIGUOUS_WORKSPACE
    );
  });

  it("does not read a pending or rejected workspace", async () => {
    await Promise.all(
      (["pending", "rejected"] as const).map(async (status) => {
        let calls = 0;
        await assert.rejects(
          readInstantlySubworkspace(
            "secret-key",
            { id: WORKSPACE_ID },
            "accounts",
            {},
            {
              fetch: () => {
                calls += 1;
                return json({ items: [member({ status })] });
              },
            }
          ),
          NO_ACCEPTED_WORKSPACE
        );
        assert.equal(calls, 1);
      })
    );
  });

  it("allowlists account fields instead of returning provider credentials", async () => {
    const result = await readInstantlySubworkspace(
      "secret-key",
      { id: WORKSPACE_ID },
      "accounts",
      {},
      {
        fetch: (url) =>
          String(url).includes("workspace-group-members")
            ? json({ items: [member()] })
            : json({
                items: [
                  {
                    email: "sender@example.com",
                    provider_code: 2,
                    provider_credentials: { password: "private" },
                    smtp_password: "private",
                    status: 1,
                  },
                ],
              }),
      }
    );

    assert.deepEqual(result.items, [
      { email: "sender@example.com", provider_code: 2, status: 1 },
    ]);
  });

  it("forces email previews and strips bodies, attachments, and addresses", async () => {
    const calls: Array<{ init?: RequestInit; url: string }> = [];
    const fetchStub: typeof fetch = (url, init) => {
      calls.push({ init, url: String(url) });
      return String(url).includes("workspace-group-members")
        ? json({ items: [member()] })
        : json({
            items: [
              {
                attachment_json: { files: [{ url: "https://private" }] },
                bcc_address_email_list: "bcc@example.com",
                bcc_address_json: [{ address: "bcc@example.com" }],
                body: { html: "<p>private</p>", text: "private" },
                cc_address_email_list: "cc@example.com",
                cc_address_json: [{ address: "cc@example.com" }],
                content_preview: "A bounded preview",
                from_address_email: "sender@example.com",
                from_address_json: [{ address: "sender@example.com" }],
                id: "email-1",
                reply_to: "reply@example.com",
                subject: "Question",
                to_address_email_list: "recipient@example.com",
                to_address_json: [{ address: "recipient@example.com" }],
              },
            ],
          });
    };

    const result = await readInstantlySubworkspace(
      "secret-key",
      { id: WORKSPACE_ID },
      "emails",
      {
        emailType: "received",
        latestOfThread: true,
        lead: "lead@example.com",
      },
      { fetch: fetchStub }
    );

    assert.deepEqual(result.items, [
      {
        content_preview: "A bounded preview",
        id: "email-1",
        subject: "Question",
      },
    ]);
    assert.equal(
      calls[1]?.url.endsWith(
        "/emails?limit=20&preview_only=true&email_type=received&latest_of_thread=true&lead=lead%40example.com"
      ),
      true
    );
  });
});
