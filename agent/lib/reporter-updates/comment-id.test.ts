import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commentIdFor } from "./comment-id.js";
import { STAGES } from "./copy.js";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe("commentIdFor", () => {
  it("is a valid version 4 id, the same every time for one ticket and stage", () => {
    for (const stage of STAGES) {
      assert.match(commentIdFor("ENG-1", stage), UUID_V4);
      assert.equal(commentIdFor("ENG-1", stage), commentIdFor("ENG-1", stage));
    }
  });

  it("differs for every ticket and stage", () => {
    const ids = new Set<string>();
    for (const issue of ["ENG-1", "ENG-2", "ENG-12"]) {
      for (const stage of STAGES) {
        ids.add(commentIdFor(issue, stage));
      }
    }
    assert.equal(ids.size, 12);
  });
});
