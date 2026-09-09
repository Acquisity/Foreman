import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const NAMESPACE_TRANSPORT =
  /import\s+\*\s+as\s+\w+\s+from\s+["'][^"']*\/transport\.js["']/;
test("authored callers cannot bypass Executor dispatch through the wire adapter", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  for (const path of readdirSync(root, { recursive: true })) {
    const name = String(path).replaceAll("\\", "/");
    if (
      !name.endsWith(".ts") ||
      name.endsWith(".test.ts") ||
      ["lib/executor/dispatch.ts", "lib/executor/transport.ts"].includes(name)
    ) {
      continue;
    }
    const source = readFileSync(join(root, name), "utf8");
    assert.ok(
      !(
        source.includes("executorTransport") || NAMESPACE_TRANSPORT.test(source)
      ),
      `${name} bypasses Executor dispatch`
    );
  }
});
