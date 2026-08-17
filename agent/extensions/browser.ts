import browser from "@agent-browser/eve";

/**
 * Browser automation for the orchestrator, mounted as an eve extension.
 *
 * @remarks
 * - Tools appear to the model as `browser__<name>` (navigate, snapshot, click, fill,
 *   screenshot, and the rest); the extension ships its own instructions fragment, so the
 *   orchestrator prompt needs no additions.
 * - The browser runs entirely inside the root sandbox via the agent-browser CLI; the app
 *   runtime only relays commands, and no credentials ever reach the page. agent-browser is
 *   pre-installed at template build time in `agent/sandbox.ts`.
 * - `contentBoundaries` wraps page output in markers so web content stays recognizable as
 *   untrusted data, and `maxOutputChars` bounds what a single page read can push into the
 *   orchestrator's context.
 */
export default browser({
  contentBoundaries: true,
  maxOutputChars: 50_000,
});
