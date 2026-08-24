import { defineMcpClientConnection } from "eve/connections";
import linear, {
  LINEAR_TRIAGE_READ_TOOLS,
} from "../../../connections/linear.js";

export default defineMcpClientConnection({
  ...linear,
  description:
    "Linear investigation evidence, read-only: issues, comments, and labels. No issue, comment, document, relation, priority, state, or assignment writes.",
  tools: { allow: [...LINEAR_TRIAGE_READ_TOOLS] },
});
