# Triage replay

This folder scores Foreman's triage against what people decided later (ENG-16049). It replays settled ENG tickets through today's triage code and checks the verdict, classification, handling path, project, owner, duplicate and master. Every Foreman triage change should show it helped here before it ships.

## What's here

- `cases/<ENG-id>.json`: 150 frozen cases. Each holds the ticket as first filed (scrubbed), its intake lane, the Acquisity commit on main when it was filed, the ticket's fields as filed (`asFiled`), and related issues as they were then. A field history can't settle reads `unknown`.
- `split.json`: train and held-out ids, split by incident group, so tickets that share a master never land on both sides.
- `labels/train.json`: labels for the train cases, taken only from human outcomes (a merged fix, human state changes and comments, billing actions, closures nobody reopened). A case with no clear ground truth is labelled `insufficient` and left out of every field score. Held-out labels live outside this repository, in the ENG-16049 task folder.
- `frozen/`: the ENG projects, labels, users and workflow states, read 23 Oct 2026, each with its Linear `createdAt`. The replay answers only entries created before the case.

## The boundary

A replay server runs with `TRIAGE_REPLAY=1`. It refuses to boot with `VERCEL_ENV=production`, `FOREMAN_MEMORY_DATABASE_URL` or a warm sandbox snapshot. Inside a replay:

- `executorClient` answers every `linear.*` operation from a simulated store for the case, seeded with the ticket as filed, and refuses every other operation with a 503, recorded as an evidence miss.
- The Executor connection is denied, so `executor__execute` can't reach real Linear. The replay tools stand in for it: `read_triage_replay_issue`, `comment_triage_replay_issue`, `create_triage_replay_issue`, `list_triage_replay_catalog` and, for the critic, `read_triage_replay_document`.
- `reply_to_requester` returns a posted reply without sending it.
- `invokeProvider` refuses every other provider call with a 503 (`triage_replay_closed`), so PlanetScale, Sentry and the other provider reads that skip `executorClient` get nothing.
- `prepare_repository` and the critic's `checkout_commit` get only a `git archive` of the case's commit, with no history, so Foreman can't see the later fix. Both return that commit, which Foreman records instead of running `git rev-parse HEAD`.

The model's own provider tools, such as web search, aren't stripped, so a replay can still search the open web.

## Running a replay

A replay costs live model calls: an Opus triage, the critic and Jev per case, so it runs only after James approves the spend. On the server set `TRIAGE_REPLAY=1`, `FOREMAN_DIAGNOSTICS_SECRET` (at least 32 characters), `TRIAGE_REPLAY_MAX_RUNS`, the number of starts the process allows (default 3), and, for a local server, `TRIAGE_REPLAY_COMMIT` to the Foreman commit it runs (a deployment falls back to `VERCEL_GIT_COMMIT_SHA`). Replay state is a private Blob object per case; `TRIAGE_REPLAY_STATE=memory` keeps it in the process for a single local `eve dev`.

```bash
tsx scripts/triage-replay-archives.ts --acquisity <Acquisity checkout> --split heldout --out archives.json
FOREMAN_DIAGNOSTICS_SECRET=<secret> tsx scripts/triage-replay.ts \
  --url <replay server> --run-id <run id> --archives archives.json --split heldout [--runs 1]
```

The runner starts one case at a time, polls until the root turn ends, and writes one result file per case and run under `.eve/triage-replay/<run id>/`. A run is `completed` only when it reached a terminal outcome: a route the store applied to the case (after the critic settled, when the decision needs review), a billing route, or an unproven stop with its document saved.

## Scoring

```bash
pnpm triage:score .eve/triage-replay/<run id> --heldout-labels <path to heldout.json> [--runs N]
```

The scorer writes `scorecard.md` and `scores.json` next to the results. Every case in the split counts once per run, so a missing, failed or cancelled run scores wrong on every field. Train and held-out score apart, each split by intake lane. Text fields match trimmed and case-folded, and a field the label leaves null is unscored. Duplicates match as sets of issue ids, where null means not a duplicate. A master filed after the case means the run should have created a new one. The scorer refuses results from more than one run id or Foreman commit, or with an unknown commit, so a baseline and a candidate are never scored together.

## Live logging

Outside a replay, every triage logs countable lines with the issue id. `triage.decision` logs each time `decide_triage` settles (`decide`, then `adjudicate` for a later decision on the same ticket) and whenever `route_ticket` writes a ticket, with the duplicate only when Linear confirmed the relation. A route with no Jev decision logs `code: skill_fallback`, and a route matching `decide_billing`'s Support route for that ticket logs `code: billing`. `critic.verdict` logs when the critic settles, against the ticket on the dispatch message's first line (`Source issue: ENG-123`).
