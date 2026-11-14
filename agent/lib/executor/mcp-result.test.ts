import assert from "node:assert/strict";
import { test } from "node:test";
import { mcpResultText } from "./mcp-result.js";

test("structured data wins, as JSON; otherwise text parts are joined", () => {
  assert.equal(
    mcpResultText({ content: [], structuredContent: { rows: [{ one: 1 }] } }),
    '{"rows":[{"one":1}]}'
  );
  assert.equal(
    mcpResultText({
      content: [
        { text: "a", type: "text" },
        { data: "x", type: "image" },
        { text: "b", type: "text" },
      ],
    }),
    "a\nb"
  );
  assert.equal(
    mcpResultText(
      {
        content: [
          { text: "a", type: "text" },
          { text: "b", type: "text" },
        ],
      },
      ""
    ),
    "ab"
  );
  assert.equal(mcpResultText({ content: [] }), "");
  assert.equal(mcpResultText({ content: "invalid" }), undefined);
  assert.equal(mcpResultText(null), undefined);
});
