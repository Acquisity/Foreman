import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.INNGEST_MCP_CONNECTOR ??= "api.inngest.com/test";
process.env.LINEAR_CONNECTOR ??= "linear/test";
process.env.PLANETSCALE_MCP_CONNECTOR ??= "planet-scale-read-only-foreman/test";

const { default: tool } = await import("../tools/find_function_runs.js");

const CREDENTIAL_UNAVAILABLE = /Inngest credential unavailable: no grant/u;

describe("find_function_runs tool", () => {
  it("returns a structured error when the token cannot be minted", async () => {
    const context = {
      abortSignal: new AbortController().signal,
      getToken: () => Promise.reject(new Error("no grant")),
    } as unknown as Parameters<typeof tool.execute>[1];
    const result = (await tool.execute({}, context)) as {
      error?: string;
      latestTrace: unknown;
      runs: unknown[];
    };
    assert.match(result.error ?? "", CREDENTIAL_UNAVAILABLE);
    assert.deepEqual(result.runs, []);
    assert.equal(result.latestTrace, null);
  });
});
