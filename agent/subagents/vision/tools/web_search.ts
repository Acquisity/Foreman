import { disableTool } from "eve/tools";

/**
 * Removes eve's built-in `web_search` tool from the vision child.
 *
 * @remarks
 * The answer is in the pixels the parent pointed at, never on the web. A child
 * with no image ran two searches for the ticket text instead of saying it had
 * nothing to read.
 */
export default disableTool();
