/**
 * Prints the capability catalog each session lane carries, measured from
 * eve's compiled manifest (`pnpm report:capabilities`).
 *
 * Run `npx eve info` or `pnpm build` first: both write
 * `.eve/compile/compiled-agent-manifest.json`, which this report reads. It
 * needs the same connector variables those commands need, loaded from `.env`
 * and `.env.local` when they exist. The report measures only. It changes
 * nothing about what any lane may call.
 */
import {
  COMPILED_MANIFEST_PATH,
  formatCapabilityBudget,
  measureCapabilityBudget,
  readCompiledManifest,
} from "../agent/lib/capability-budget.js";

const appRoot = new URL("../", import.meta.url);
const manifest = readCompiledManifest(appRoot);

if (!manifest) {
  throw new Error(
    `${COMPILED_MANIFEST_PATH} is missing. Run 'npx eve info' first.`
  );
}

process.stdout.write(
  `${formatCapabilityBudget(await measureCapabilityBudget(manifest))}\n`
);
