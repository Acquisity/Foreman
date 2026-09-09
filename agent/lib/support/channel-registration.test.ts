import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { z } from "zod";

it("registers the support handoff in Eve's compiled channel catalog", () => {
  // pnpm validate compiles with eve info before running tests. Source imports alone
  // missed the production failure: Eve silently omitted a channel with no routes.
  const manifest = z
    .object({
      channels: z.array(
        z.object({ method: z.string(), name: z.string(), urlPath: z.string() })
      ),
    })
    .parse(
      JSON.parse(
        readFileSync(
          new URL(
            "../../../.eve/compile/compiled-agent-manifest.json",
            import.meta.url
          ),
          "utf8"
        )
      )
    );
  const support = manifest.channels.filter(
    (channel) => channel.name === "support"
  );
  assert.equal(support.length, 1);
  assert.equal(support[0].method, "GET");
  assert.equal(support[0].urlPath, "/internal/support");
});
