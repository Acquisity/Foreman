import { disableTool } from "eve/tools";

/**
 * Removes eve's built-in `bash` tool from the vision child.
 *
 * @remarks
 * Handed a delegation with no image reference, the child used `bash` to crawl
 * the shared sandbox for something to read: `find / -name "*.png"`, then the
 * whole dump re-sent on every following step. One production run reached 106
 * steps and 46 out-of-memory kills before it failed and left the parent Slack
 * turn hung. The station reads one image it was given a url or a path for, so
 * a shell is capability it never needs.
 */
export default disableTool();
