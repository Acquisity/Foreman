import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  OperationRequest,
  ProviderClient,
} from "./executor/operations.js";
import {
  InstantlyApiError,
  readInstantlySubworkspace,
} from "./instantly-api.js";
import {
  AMBIGUOUS_WORKSPACE,
  inputOf,
  json,
  MAX_TEST_RESPONSE_BYTES,
  member,
  NO_ACCEPTED_WORKSPACE,
  SECOND_WORKSPACE_ID,
  WORKSPACE_ID,
} from "./instantly-fixtures.js";

describe("Instantly subworkspace reads", () => {
  it("rejects duplicate accepted workspace IDs before a resource read", async () => {
    let calls = 0;
    await assert.rejects(
      readInstantlySubworkspace(
        { id: WORKSPACE_ID },
        "accounts",
        {},
        {
          client: () => {
            calls += 1;
            return json({ items: [member(), member()] });
          },
        }
      ),
      (error) =>
        error instanceof InstantlyApiError && error.kind === "invalid-response"
    );
    assert.equal(calls, 1);
  });
  it("rejects invalid direct-call limits before contacting Instantly", async () => {
    await Promise.all(
      [0, 101, Number.NaN, 1.5].map(async (limit) => {
        let calls = 0;
        await assert.rejects(
          readInstantlySubworkspace(
            { id: WORKSPACE_ID },
            "campaigns",
            { limit },
            {
              client: () => {
                calls += 1;
                return json({ items: [member()] });
              },
            }
          ),
          (error) => {
            assert.ok(error instanceof InstantlyApiError);
            assert.equal(error.kind, "invalid-input");
            return true;
          }
        );
        assert.equal(calls, 0);
      })
    );
  });

  it("finds an authoritative ID beyond page one and propagates the resource cursor", async () => {
    const calls: OperationRequest[] = [];
    const fetchStub: ProviderClient = (request) => {
      calls.push(request);
      const calledUrl = request.operation;
      if (inputOf(request).starting_after === "group-page-two") {
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
      { id: WORKSPACE_ID },
      "campaigns",
      { limit: 50, search: "Renewals", startingAfter: "campaign-cursor" },
      { client: fetchStub }
    );

    assert.deepEqual(result, {
      items: [{ id: "campaign-1", name: "Campaign" }],
      nextStartingAfter: "next-resource",
      resource: "campaigns",
      workspace: { id: WORKSPACE_ID, name: "Rick Livingston's Workspace" },
    });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[2], {
      input: {
        limit: 50,
        search: "Renewals",
        starting_after: "campaign-cursor",
        status: undefined,
        "x-as-workspace": WORKSPACE_ID,
      },
      operation: "instantly.campaigns",
    });
  });

  it("normalizes an exact workspace name and rejects ambiguous matches", async () => {
    const result = await readInstantlySubworkspace(
      { name: "  RICK   LIVINGSTON'S workspace " },
      "accounts",
      {},
      {
        client: (request) =>
          request.operation === "instantly.workspace-group-members"
            ? json({ items: [member()] })
            : json({ items: [] }),
      }
    );
    assert.equal(result.workspace.id, WORKSPACE_ID);

    await assert.rejects(
      readInstantlySubworkspace(
        { name: "Duplicate" },
        "accounts",
        {},
        {
          client: () =>
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
            { id: WORKSPACE_ID },
            "accounts",
            {},
            {
              client: () => {
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
      { id: WORKSPACE_ID },
      "accounts",
      {},
      {
        client: (request) =>
          request.operation === "instantly.workspace-group-members"
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

  it("rejects a sanitized resource page that exceeds the output budget", async () => {
    const preview = "x".repeat(MAX_TEST_RESPONSE_BYTES - 150);
    await assert.rejects(
      readInstantlySubworkspace(
        { id: WORKSPACE_ID },
        "emails",
        {},
        {
          client: (request) =>
            request.operation === "instantly.workspace-group-members"
              ? json({ items: [member()] })
              : json({ items: [{ content_preview: preview, id: "email-1" }] }),
        }
      ),
      (error) => {
        assert.ok(error instanceof InstantlyApiError);
        assert.equal(error.kind, "too-much-data");
        return true;
      }
    );
  });

  it("forces email previews and strips bodies, attachments, and addresses", async () => {
    const calls: OperationRequest[] = [];
    const fetchStub: ProviderClient = (request) => {
      calls.push(request);
      return request.operation === "instantly.workspace-group-members"
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
      { id: WORKSPACE_ID },
      "emails",
      {
        emailType: "received",
        latestOfThread: true,
        lead: "lead@example.com",
      },
      { client: fetchStub }
    );

    assert.deepEqual(result.items, [
      {
        content_preview: "A bounded preview",
        id: "email-1",
        subject: "Question",
      },
    ]);
    assert.equal(calls[1]?.operation, "instantly.emails");
    assert.equal(inputOf(calls[1]).preview_only, true);
    assert.equal(inputOf(calls[1]).latest_of_thread, true);
    assert.equal(inputOf(calls[1]).lead, "lead@example.com");
  });
});
