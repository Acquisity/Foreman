// Files or reuses the Fixy ticket for an open generated PR. Called by .github/workflows/widget-guide.yml, and by the
// widget tools workflow once it exists (ENG-20296):
//   LINEAR_API_KEY=... tsx scripts/generated-pr-ticket.ts --kind guide|tools --pr <Foreman PR URL>
import { parseArgs } from "node:util";
import {
  fileOrReuseTicket,
  GENERATED_PR_KINDS,
  type GeneratedPrKind,
  linearRequest,
} from "../agent/lib/generated-pr-ticket.js";

const { values } = parseArgs({
  options: { kind: { type: "string" }, pr: { type: "string" } },
});
const key = process.env.LINEAR_API_KEY;
if (!key) {
  throw new Error("LINEAR_API_KEY is not set");
}
if (!(values.kind && values.kind in GENERATED_PR_KINDS && values.pr)) {
  throw new Error("Usage: --kind guide|tools --pr <Foreman PR URL>");
}
const { identifier, reused } = await fileOrReuseTicket(
  linearRequest(key),
  values.kind as GeneratedPrKind,
  values.pr
);
console.log(`${reused ? "Reused" : "Filed"} ${identifier} for ${values.pr}`);
