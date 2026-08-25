// The critic declares its own skill, and eve's sandbox registry refuses a
// child that selects parent.sandbox while carrying managed workspace resources
// (skills are one). So the critic gets its own sandbox instance from the same
// definition as the root: same Vercel backend, same warm repository snapshot,
// same safe.directory session hook. It prepares and pins the repository itself
// with prepare_repository and checkout_commit.
// biome-ignore lint/performance/noBarrelFile: eve discovers a child sandbox by path, so the root definition is mounted here rather than duplicated.
export { default } from "../../sandbox.js";
