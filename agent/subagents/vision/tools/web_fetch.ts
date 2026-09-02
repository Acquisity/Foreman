import { disableTool } from "eve/tools";

/**
 * Removes eve's built-in `web_fetch` tool from the vision child.
 *
 * @remarks
 * `read_image` fetches the one remote host this station reads, Linear's upload
 * store, with the app token. A general fetcher adds no image it could see and
 * gives the child another way to wander when the delegation named no image.
 */
export default disableTool();
