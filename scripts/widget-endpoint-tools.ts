// Regenerates agent/lib/widget-endpoint-manifest.ts from Acquisity's support
// endpoint manifest (ENG-20296), with no model. Called by
// .github/workflows/widget-tools.yml:
//   tsx scripts/widget-endpoint-tools.ts --manifest <serialized manifest JSON> --commit <Acquisity SHA>
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { renderEndpointManifest } from "../agent/lib/widget-endpoint-schema.js";

const OUT = "agent/lib/widget-endpoint-manifest.ts";

const { values } = parseArgs({
  options: { commit: { type: "string" }, manifest: { type: "string" } },
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
    { encoding: "utf8", input: text, maxBuffer: 16 * 1024 * 1024 }
  );

const { changed, source } = renderEndpointManifest(
  readFileSync(values.manifest, "utf8"),
  values.commit,
  readFileSync(OUT, "utf8"),
  format
);
if (changed) {
  writeFileSync(OUT, source);
  console.log(`regenerated ${OUT} from Acquisity ${values.commit}`);
} else {
  console.log(
    "manifest unchanged: only the commit differs, file left as it was"
  );
}
