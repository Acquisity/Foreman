import { disableTool } from "eve/tools";

/**
 * Removes eve's built-in `todo` tool from the vision child.
 *
 * @remarks
 * The station's whole task is one `read_image` call and one answer. A durable
 * list only spends steps on bookkeeping for work that has no second step.
 */
export default disableTool();
