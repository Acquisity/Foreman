import { defineSandbox } from "eve/sandbox";

// The critic reads the same prepared repository the investigation read, so it
// shares the parent's live sandbox exactly like the reviewer does. A sharing
// child may not declare its own skills/, which is why the whole procedure
// lives in instructions.md.
export default defineSandbox(({ parent }) => {
  if (parent === null) {
    throw new Error("critic must run as a child");
  }
  return parent.sandbox;
});
