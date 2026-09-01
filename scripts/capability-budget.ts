/**
 * Prints the capability catalog each session lane carries, measured from
 * eve's compiled manifest (`pnpm report:capabilities`).
 *
 * The manifest is compiled here, immediately before it is read, so the numbers
 * always describe the working tree rather than whatever `.eve/` happened to
 * hold. `eve info` needs the same connector variables the agent needs; the
 * package script loads them from `.env` and `.env.local` when they exist, and
 * this process passes its environment to the compile. The report measures
 * only. It changes nothing about what any lane may call.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  formatCapabilityBudget,
  measureCapabilityBudget,
  readCompiledManifest,
} from "../agent/lib/capability-budget.js";

const appRoot = new URL("../", import.meta.url);

// A local compile, not an outside call, but still bounded: a compile that
// hangs must fail the report rather than hold the terminal.
const COMPILE_TIMEOUT_MS = 120_000;

execFileSync(
  fileURLToPath(new URL("node_modules/.bin/eve", appRoot)),
  ["info"],
  {
    cwd: fileURLToPath(appRoot),
    stdio: ["ignore", "ignore", "inherit"],
    timeout: COMPILE_TIMEOUT_MS,
  }
);

process.stdout.write(
  `${formatCapabilityBudget(await measureCapabilityBudget(readCompiledManifest(appRoot)))}\n`
);
