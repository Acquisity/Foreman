import { defineTool } from "eve/tools";
import {
  readSentryIssue,
  sentryIssueInput,
} from "../../../lib/executor/sentry.js";

export default defineTool({
  description:
    "Read a Sentry issue's details or search its events. These are the two issue evidence operations that Sentry now exposes through its catalog. Use search_issues in Executor to find an issue first. No writes or other catalog operations are available through this helper.",
  execute(input, ctx) {
    return readSentryIssue(input, ctx);
  },
  inputSchema: sentryIssueInput,
});
