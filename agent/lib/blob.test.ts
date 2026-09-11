import assert from "node:assert/strict";
import { test } from "node:test";
import {
  reservedNamespaceForPath,
  reservedNamespaceForUrl,
  reservedReadMessage,
  reservedWriteMessage,
} from "./blob.js";

test("retired records remain inaccessible to generic Blob tools", () => {
  for (const prefix of ["artifacts/", "pipeline-runs/"]) {
    const namespace = reservedNamespaceForPath(`/${prefix}record.md`);
    assert.ok(namespace);
    assert.deepEqual(
      reservedNamespaceForUrl(
        `https://example.public.blob.vercel-storage.com/${prefix}record.md`
      ),
      namespace
    );
    assert.ok(reservedReadMessage(namespace).includes("not available"));
    assert.ok(reservedWriteMessage(namespace).includes("cannot be changed"));
    assert.equal(namespace.readTool, undefined);
    assert.equal(namespace.writeTool, undefined);
  }
});

test("legacy repository knowledge retains the current owning tools", () => {
  const namespace = reservedNamespaceForPath("factory-brain/record.md");
  assert.ok(namespace);
  assert.equal(namespace.readTool, "read_repository_knowledge");
  assert.equal(namespace.writeTool, "update_repository_knowledge");
});
