import { defineState } from "eve/context";

/**
 * The repository this session prepared at runtime, for the capability gate.
 *
 * @remarks
 * `prepare_repository` writes `/workspace/.foreman/repository.json`, and that
 * marker stays the source of truth: stations read it, a switch rolls it back,
 * and nothing here replaces it. What the marker cannot do is be read from a
 * dynamic tool resolver, which has no sandbox. So the slug is recorded here as
 * well, and only the slug, because that is all
 * {@link repositoryCapabilitiesAvailable} needs to know a repository was
 * selected.
 *
 * This is capability composition, exactly like the auth stamp it sits beside.
 * It decides what is advertised, never what is permitted: authority still
 * comes from the signed auth, `agent/lib/trust.ts` still decides trust,
 * `agent/lib/github/approval.ts` still decides approval, and
 * `intakeOnlyPolicy` still denies push and pull-request creation whatever this
 * returns.
 *
 * eve's `defineState` reads through `loadContext()`, and eve dispatches a
 * dynamic resolver at `step.started` with that context active, which is how
 * eve's own `connection_search` reads its registry. So a repository prepared
 * mid-turn is visible on the next step of the same turn, and
 * `prepare_repository` followed by a push works in one message. Both accessors
 * are still defensive: a resolver that throws loses its whole result, so an
 * absent context degrades to the auth-only answer rather than dropping the
 * catalog.
 */
const selectedRepository = defineState<string | null>(
  "foreman.selectedRepository",
  () => null
);

/** Records the validated repository `prepare_repository` just selected. */
export const rememberSelectedRepository = (slug: string): void => {
  try {
    selectedRepository.update(() => slug);
  } catch {
    // Recording is a hint for the catalog, never the record itself. The marker
    // file is written either way, so a context eve did not give us costs the
    // session a wider catalog, not the prepared repository.
  }
};

/** The repository this session prepared, or null when none is readable. */
export const selectedRepositorySlug = (): string | null => {
  try {
    return selectedRepository.get();
  } catch {
    return null;
  }
};
