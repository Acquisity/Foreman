import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLinearResponse } from "./linear-response.js";

test("paginated Linear reads require a usable continuation cursor", () => {
  for (const operation of ["RelatedIssues", "TeamLabels"] as const) {
    const key = operation === "RelatedIssues" ? "issues" : "issueLabels";
    for (const endCursor of [undefined, null, ""]) {
      const data = {
        [key]: { nodes: [], pageInfo: { endCursor, hasNextPage: true } },
      };
      assert.throws(() => parseLinearResponse(operation, { data }));
      data[key].pageInfo.hasNextPage = false;
      assert.deepEqual(parseLinearResponse(operation, { data }), data);
    }
    const data = {
      [key]: { nodes: [], pageInfo: { endCursor: "next", hasNextPage: true } },
    };
    assert.deepEqual(parseLinearResponse(operation, { data }), data);
  }
});
