// biome-ignore lint/performance/noBarrelFile: eve discovers child connections by path, so the read-only root definition is mounted here unchanged, auth included.
export { default } from "../../../connections/inngest.js";
