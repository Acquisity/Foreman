import { disableTool } from "eve/tools";

/**
 * Removes eve's built-in `write_file` tool from the vision child.
 *
 * @remarks
 * The station answers in text and returns structured output. It shares the
 * parent's sandbox, so anything it wrote would land in the caller's checkout.
 */
export default disableTool();
