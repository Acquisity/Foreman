// Regenerates agent/lib/widget-endpoint-manifest.ts from Acquisity's support
// endpoint manifest (ENG-20296), with no model. Called by
// .github/workflows/widget-tools.yml:
//   tsx scripts/widget-endpoint-tools.ts --manifest <serialized manifest JSON> --commit <Acquisity SHA> [--previous <file>]
// --previous is the file to compare with (the pending bot PR's, by default the
// committed one): when only the commit differs from it, it is written back as is.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { renderEndpointManifest } from "../agent/lib/widget-endpoint-schema.js";

const OUT = "agent/lib/widget-endpoint-manifest.ts";

const { values } = parseArgs({
  options: {
    commit: { type: "string" },
    manifest: { type: "string" },
    previous: { type: "string" },
  },
});
if (
  !(values.manifest && values.commit && /^[0-9a-f]{40}$/.test(values.commit))
) {
  throw new Error("Usage: --manifest <file> --commit <40-character SHA>");
}

const format = (text: string) =>
  execFileSync(
    "pnpm",
    ["exec", "biome", "check", "--write", `--stdin-file-path=${OUT}`],
    {
      encoding: "utf8",
      input: text,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
    }
  );

const { changed, source } = renderEndpointManifest(
  readFileSync(values.manifest, "utf8"),
  values.commit,
  readFileSync(values.previous ?? OUT, "utf8"),
  format
);
writeFileSync(OUT, source);
console.log(
  changed
    ? `regenerated ${OUT} from Acquisity ${values.commit}`
    : "manifest unchanged: only the commit differs, previous file kept"
);
