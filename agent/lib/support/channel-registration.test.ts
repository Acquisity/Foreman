import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { it } from "node:test";
import { z } from "zod";

const manifestUrl = new URL(
  "../../../.eve/compile/compiled-agent-manifest.json",
  import.meta.url
);

it("registers the support handoff in Eve's compiled channel catalog", {
  skip: existsSync(manifestUrl)
    ? false
    : "run pnpm validate to compile the repository manifest first",
}, () => {
  // pnpm validate compiles with eve info before running tests. Source imports alone
  // missed the production failure: Eve silently omitted a channel with no routes.
  const manifest = z
    .object({
      channelRoutes: z.object({
        effective: z.array(
          z.object({
            method: z.string(),
            name: z.string(),
            urlPath: z.string(),
          })
        ),
      }),
    })
    .parse(JSON.parse(readFileSync(manifestUrl, "utf8")));
  const support = manifest.channelRoutes.effective.filter(
    (channel) => channel.name === "support"
  );
  assert.equal(support.length, 1);
  assert.equal(support[0].method, "GET");
  assert.equal(support[0].urlPath, "/internal/support");
});
