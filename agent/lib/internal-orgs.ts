/**
 * Acquisity's own and test workspaces, which are not customers. The live
 * scorer leaves them out of its set and capability-gap filing files nothing
 * from them (Aaron, ENG-21159).
 */
export const INTERNAL_ORGS: ReadonlySet<string> = new Set([
  // Trivox AI, the seeded demo workspace.
  "5a30d304-32ab-4ee0-b7ea-c5605aa34ce5",
  // Aaron Fraga's Workspace (Aaron's own; also the scrubber's fixture name, so scrubbed text naming it is not this org).
  "af11d514-3fbd-459c-8425-81b6b80929a0",
  // Internal, not customers (Aaron, 2026-10-09).
  "196e6aca-a8d4-4531-bbd0-babd8aa2f26f",
  "900f11b4-8949-4a3a-8e8a-19eaceae72df",
  "b99fe507-7226-4878-90c4-006b16e7bddd",
]);
