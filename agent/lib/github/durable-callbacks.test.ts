import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactGithubOutput } from "./durable-callbacks.js";

const HUGE = "x".repeat(50_000);
const TRUNCATION_NOTE = /\[truncated: 30000 more characters\]$/u;
const patchLength = 4036;
const contentLength = 20_036;

describe("compactGithubOutput", () => {
  it("truncates a file body and keeps the rest of the result", () => {
    const output = compactGithubOutput({ content: HUGE, path: "a.ts" }) as {
      content: string;
      path: string;
    };
    assert.equal(output.content.length, contentLength);
    assert.match(output.content, TRUNCATION_NOTE);
    assert.equal(output.path, "a.ts");
  });

  it("truncates patches in a bare file list", () => {
    const output = compactGithubOutput([{ filename: "a.ts", patch: HUGE }]) as {
      filename: string;
      patch: string;
    }[];
    assert.equal(output[0].patch.length, patchLength);
    assert.equal(output[0].filename, "a.ts");
  });

  it("truncates patches nested under files", () => {
    const output = compactGithubOutput({
      files: [{ patch: HUGE }],
      sha: "abc",
    }) as { files: { patch: string }[]; sha: string };
    assert.equal(output.files[0].patch.length, patchLength);
    assert.equal(output.sha, "abc");
  });

  it("leaves short values and unpatched files alone", () => {
    for (const output of [
      { content: "short" },
      { files: [{ filename: "a.ts" }] },
      { number: 7 },
      [],
      null,
      "text",
    ]) {
      assert.deepEqual(compactGithubOutput(output), output);
    }
  });
});
