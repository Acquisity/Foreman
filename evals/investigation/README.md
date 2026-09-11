# Investigation decision replays

These scripts make paid model calls against synthetic, fixed evidence. They do not invoke Foreman, Executor, Slack, or customer services. They isolate response interpretation and next-action decisions; they are not end-to-end latency tests or evidence that a prompt change improves production investigations.

Run from the repository root with an authorized AI Gateway key or Vercel OIDC environment. Store the output in an ignored private directory. For example:

```bash
LINEAR_CONNECTOR=placeholder/foreman-ci EXECUTOR_MCP_CONNECTOR=placeholder/foreman-ci SUPERMEMORY_MCP_CONNECTOR=placeholder/foreman-ci REPLAY_PROVIDER=deepinfra pnpm exec tsx --env-file=.env.local evals/investigation/replay.ts .context/decisions.jsonl
REPLAY_PROVIDER=deepinfra pnpm exec tsx --env-file=.env.local evals/investigation/executor-replay.ts .context/executor.jsonl
```

The scripts use `deepseek/deepseek-v4.1-flash` and restrict both arms to the same provider. `REPLAY_PROVIDER` defaults to `deepinfra`; use a catalog-verified provider slug. Capacity failures remain in the output, not silently rerouted or graded as incorrect reasoning. Calls are sequential within each script. Run one script at a time when comparing elapsed time.

The decision replay compares the investigation, clarification, and tool-catalog text at commit `e01e861f72c6b5b4f50ccd69a6d5cd9fe953a190` against the same text plus a candidate completion paragraph. That commit must exist locally. Both arms receive the working-tree general prompt. `REPLAY_REPETITIONS` defaults to 3; `REPLAY_MAX_OUTPUT` defaults to 8192. The candidate remains experimental and is not mounted in Foreman. A correct decision must both choose the expected next action and avoid claiming the incident cause is proven. Reading changed production code and pursuing a fresh runtime clue are negative controls against premature completion.

The Executor replay compares existing discovery guidance with additional decoding guidance using four cached synthetic envelopes: MCP text JSON, direct REST data, provider error, and denial. It checks extracted evidence and refusal to repeat a provider read solely for formatting. It does not execute generated code or test catalog navigation. Its candidate also remains experimental.

JSONL contains outputs, elapsed time, usage, and Gateway routing metadata. Decision replay additionally writes a `.raw` file before parsing the structured result, so an output-limit failure can be distinguished from a wrong decision. A wrong result or an infrastructure failure sets a nonzero exit code. Use a fresh output filename for each experiment because results append.

The September 11 pilot found no reliable improvement from either candidate. Strict provider filtering encountered capacity errors on Fireworks and DeepInfra. A low-output-limit Fireworks pilot was interrupted; the subsequent DeepInfra decision run used 8192 output tokens. Do not combine their durations into a speedup claim. See `.github/INVESTIGATION-RELIABILITY-AUDIT.md` for results and the separate cancellation fix.
