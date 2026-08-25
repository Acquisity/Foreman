import { defineMcpClientConnection } from "eve/connections";
import sentry from "../../../connections/sentry.js";

/**
 * The critic's Sentry surface: reads only.
 *
 * @remarks
 * The root connection exposes Sentry's full server surface, which includes
 * issue and project writes. The critic gets the confirmed read tools from
 * the triage tool catalog and nothing else. `auth` (user-scoped
 * `userConnect`) and `url` are the root's own objects.
 */
export const SENTRY_CRITIC_READ_TOOLS = [
  "find_organizations",
  "find_projects",
  "find_issues",
  "search_issues",
  "get_issue_details",
  "search_events",
  "search_issue_events",
] as const;

export default defineMcpClientConnection({
  ...sentry,
  description:
    "Sentry, read-only: organizations, projects, issues, issue details, and event search. No issue or project writes.",
  tools: { allow: [...SENTRY_CRITIC_READ_TOOLS] },
});
