import { disableTool } from "eve/tools";

/**
 * Removes eve's built-in `read_file` tool from the vision child.
 *
 * @remarks
 * `read_image` is the only reader this station needs, and it declares the
 * media type from the bytes. A text reader only invites the child to hunt the
 * sandbox for a file the parent never named.
 */
export default disableTool();
