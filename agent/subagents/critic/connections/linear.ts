import { defineMcpClientConnection } from "eve/connections";
import linear from "../../../connections/linear.js";

/**
 * The critic's Linear surface: reads only.
 *
 * @remarks
 * Spreads the root definition so `auth` (the shared app-scoped `linearAuth`
 * behind `managedConnect`), `url`, and the root `approval` predicate are the
 * same objects the root uses; only the tool allowlist is added. The root
 * connection has no allowlist because attended Foreman writes to Linear; the
 * critic never does, so every write tool the hosted server grows stays out.
 */
export const LINEAR_CRITIC_READ_TOOLS = [
  "get_issue",
  "list_issues",
  "list_comments",
  "list_issue_labels",
  "get_document",
  "list_documents",
] as const;

export default defineMcpClientConnection({
  ...linear,
  description:
    "Linear, read-only: issues, comments, labels, and documents cited by the investigation. No writes.",
  tools: { allow: [...LINEAR_CRITIC_READ_TOOLS] },
});
