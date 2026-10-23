import type { SessionAuthContext } from "eve/context";
import type { SandboxSession } from "eve/sandbox";
import { readPrivateBytes } from "../blob.js";
import { REPOSITORY_MARKER } from "../repository.js";
import { rememberSelectedRepository } from "../repository-selection.js";
import { boundedRun } from "../sandbox-deadline.js";
import { withReplayState } from "./backend.js";
import { replaySessionOf } from "./mode.js";

/**
 * The only code a replay session can read (ENG-16049): a `git archive` of
 * Acquisity at the case's creation commit, with no history and no remote,
 * unpacked into a sandbox that started from no snapshot and has no network.
 * The runner uploads the archive to Blob, privately, before the run and names
 * it in the case's store; only this process's Blob credentials can read it.
 */
export const REPLAY_REPOSITORY = "Acquisity/Acquisity";
const ARCHIVE_PATH = "/tmp/triage-replay-repository.tar.gz";
/** An Acquisity archive is about 60 MiB; a minute covers a slow Blob read. */
const ARCHIVE_FETCH_TIMEOUT_MS = 60_000;

export async function prepareReplayArchive(
  sandbox: SandboxSession,
  archive: { commit: string; url: string },
  fetchArchive: (url: string) => Promise<Uint8Array> = (url) =>
    readPrivateBytes(url, ARCHIVE_FETCH_TIMEOUT_MS)
): Promise<string | null> {
  let bytes: Uint8Array;
  try {
    bytes = await fetchArchive(archive.url);
  } catch (error) {
    return `The replay archive could not be read: ${error instanceof Error ? error.message : String(error)}`;
  }
  await sandbox.writeBinaryFile({ content: bytes, path: ARCHIVE_PATH });
  const unpacked = await boundedRun(sandbox, {
    command: `rm -rf /workspace/repo && mkdir -p /workspace/repo && tar -xzf ${ARCHIVE_PATH} -C /workspace/repo && rm -f ${ARCHIVE_PATH} && test ! -e /workspace/repo/.git`,
  });
  if (unpacked.exitCode !== 0) {
    return `The replay archive did not unpack (exit ${unpacked.exitCode}).`;
  }
  await sandbox.writeTextFile({
    content: JSON.stringify(
      {
        replayCommit: archive.commit,
        slug: REPLAY_REPOSITORY,
        source: "explicit",
        worktree: "/workspace/repo",
      },
      null,
      2
    ),
    path: REPOSITORY_MARKER,
  });
  return null;
}

export interface ReplayWorkspaceRefusal {
  refusal: { code: string; error: string };
}

export interface ReplayWorkspace {
  current: { repository: string; source: "explicit" };
  previous: null;
  replaced: false;
  repository: string;
  reused: false;
  success: true;
  worktree: "/workspace/repo";
}

/** A replay reads only the case's pinned archive; nothing is cloned or refreshed. */
export async function prepareReplayWorkspace(
  initiator: SessionAuthContext | null | undefined,
  getSandbox: () => Promise<SandboxSession>
): Promise<ReplayWorkspace | ReplayWorkspaceRefusal> {
  const session = replaySessionOf(initiator);
  if (!session) {
    return {
      refusal: {
        code: "replay_session_required",
        error:
          "A replay process prepares repositories only for replay sessions.",
      },
    };
  }
  const archive = await withReplayState(
    session.runId,
    session.caseId,
    (state) => state.archive
  );
  const error = await prepareReplayArchive(await getSandbox(), archive);
  if (error) {
    return { refusal: { code: "replay_archive_unavailable", error } };
  }
  rememberSelectedRepository(REPLAY_REPOSITORY);
  return {
    current: { repository: REPLAY_REPOSITORY, source: "explicit" as const },
    previous: null,
    replaced: false,
    repository: REPLAY_REPOSITORY,
    reused: false,
    success: true as const,
    worktree: "/workspace/repo" as const,
  };
}
