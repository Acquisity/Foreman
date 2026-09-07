import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildReadQueryResult,
  parseReadQueryResult,
  truncateRows,
} from "./planetscale.js";

const NON_JSON_ERROR = /non-JSON/;
const UNRECOGNIZED_SHAPE_ERROR = /unrecognized result shape/;

describe("truncateRows", () => {
  it("keeps every row when the total is under the cap", () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const result = truncateRows(rows, 1024);
    assert.equal(result.truncated, false);
    assert.equal(result.totalRows, 3);
    assert.equal(result.returnedRows, 3);
    assert.deepEqual(result.rows, rows);
    // [{"id":1},{"id":2},{"id":3}] = 2 brackets + 3*8 + 2 commas.
    assert.equal(result.resultBytes, 28);
  });

  it("drops rows once the cap would be exceeded", () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    // Each row is 8 bytes; the array adds 2 brackets and a comma per pair.
    // [{"id":1}] is 10 bytes, [{"id":1},{"id":2}] is 19 bytes.
    const result = truncateRows(rows, 18);
    assert.equal(result.truncated, true);
    assert.equal(result.totalRows, 3);
    assert.equal(result.returnedRows, 1);
    assert.deepEqual(result.rows, [{ id: 1 }]);
    assert.equal(result.resultBytes, 10);
  });

  it("returns an empty result for an empty input", () => {
    const result = truncateRows([], 1024);
    assert.deepEqual(result.rows, []);
    assert.equal(result.truncated, false);
    assert.equal(result.totalRows, 0);
    assert.equal(result.returnedRows, 0);
    assert.equal(result.resultBytes, 2);
    assert.equal(result.oversizedRow, false);
    assert.equal(result.envelopeTooLarge, false);
  });

  it("measures byte length, not character length", () => {
    // "é" is two UTF-8 bytes, so the cap must account for that.
    const rows = [{ name: "é" }];
    const result = truncateRows(rows, 1024);
    assert.equal(
      result.resultBytes,
      Buffer.byteLength('[{"name":"é"}]', "utf8")
    );
    assert.equal(result.truncated, false);
  });

  it("accounts for overhead bytes in the budget", () => {
    const rows = [{ id: 1 }, { id: 2 }];
    // Without overhead, cap 19 fits both rows (19 bytes).
    assert.equal(truncateRows(rows, 19).returnedRows, 2);
    // One byte of overhead shrinks the budget enough to keep only one row.
    assert.equal(truncateRows(rows, 19, 1).returnedRows, 1);
  });

  it("flags a single row that alone exceeds the cap", () => {
    const result = truncateRows([{ blob: "x".repeat(100) }], 10);
    assert.equal(result.oversizedRow, true);
    assert.equal(result.returnedRows, 0);
    assert.deepEqual(result.rows, []);
    assert.equal(result.truncated, true);
    assert.equal(result.totalRows, 1);
  });

  it("keeps the serialized rows array under the cap for many small rows", () => {
    // Small rows are the worst case: the commas between rows dominate the
    // payload, so this is the regression the ticket is about.
    const rows = Array.from({ length: 3_000_000 }, (_, i) => i % 1000);
    const capBytes = 8 * 1024 * 1024;
    const overheadBytes = 500;
    const result = truncateRows(rows, capBytes, overheadBytes);
    assert.ok(result.resultBytes <= capBytes - overheadBytes);
    assert.equal(
      Buffer.byteLength(JSON.stringify(result.rows), "utf8"),
      result.resultBytes
    );
    assert.equal(result.truncated, true);
  });
});

describe("parseReadQueryResult", () => {
  it("parses a bare JSON array into rows with no passthrough", () => {
    const result = parseReadQueryResult('[{"id":1},{"id":2}]');
    assert.deepEqual(result.rows, [{ id: 1 }, { id: 2 }]);
    assert.deepEqual(result.passthrough, {});
  });

  it("parses an object with a rows array and preserves other fields verbatim", () => {
    const result = parseReadQueryResult(
      '{"rows":[{"id":1}],"columns":["id"],"total":1}'
    );
    assert.deepEqual(result.rows, [{ id: 1 }]);
    assert.deepEqual(result.passthrough, { columns: ["id"], total: 1 });
  });

  it("throws on non-JSON content", () => {
    assert.throws(() => parseReadQueryResult("not json"), NON_JSON_ERROR);
  });

  it("throws on an object without a rows array", () => {
    assert.throws(
      () => parseReadQueryResult('{"foo":"bar"}'),
      UNRECOGNIZED_SHAPE_ERROR
    );
  });
});

describe("buildReadQueryResult", () => {
  it("preserves small metadata and drops an oversized envelope", () => {
    const cap = 256 * 1024;
    const small = buildReadQueryResult([{ n: 1 }], { columns: ["n"] }, cap);
    assert.deepEqual(small.columns, ["n"]);
    assert.deepEqual(small.rows, [{ n: 1 }]);
    const large = buildReadQueryResult(
      [{ n: 1 }],
      { metadata: "x".repeat(cap) },
      cap
    );
    assert.equal(large.envelopeTooLarge, true);
    assert.equal(large.metadata, undefined);
    assert.deepEqual(large.rows, []);
    assert.ok(Buffer.byteLength(JSON.stringify(large)) <= cap);
    assert.equal(truncateRows([1], cap, cap).envelopeTooLarge, true);
  });
  it("bounds the complete serialized result at the 256 KiB boundary", () => {
    const cap = 256 * 1024;
    for (const padding of [
      cap - 144,
      cap - 150,
      cap - 153,
      cap - 154,
      cap,
      cap + 1,
    ]) {
      const result = buildReadQueryResult(
        [{ value: "x".repeat(padding) }],
        {},
        cap
      );
      assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= cap);
    }
    const rows = Array.from({ length: 10_000 }, () => ({
      value: "é".repeat(20),
    }));
    const result = buildReadQueryResult(rows, { columns: ["value"] }, cap);
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= cap);
  });
});
