// biome-ignore lint/performance/noBarrelFile: eve discovers child connections by path, so the read-only root definition is mounted here unchanged, auth included. Read-only by OAuth scope, not by tool filter.
export { default } from "../../../connections/posthog.js";
