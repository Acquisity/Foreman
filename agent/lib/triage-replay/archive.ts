import { get } from "@vercel/blob";
import type { SessionAuthContext } from "eve/context";
import type { SandboxSession } from "eve/sandbox";
import { REPOSITORY_MARKER } from "../repository.js";
import { boundedRun } from "../sandbox-deadline.js";
import { readReplayState } from "./backend.js";
import { replaySessionOf } from "./mode.js";

export const REPLAY_REPOSITORY = "Acquisity/Acquisity";
const ARCHIVE_PATH = "/tmp/triage-replay-repository.tar.gz";
const ARCHIVE_FETCH_TIMEOUT_MS = 60_000;
const WORKTREE = "/workspace/repo";

async function readArchive(url: string): Promise<Uint8Array> {
  const result = await get(url, {
    abortSignal: AbortSignal.timeout(ARCHIVE_FETCH_TIMEOUT_MS),
    access: "private",
  });
  if (!result?.stream) {
    throw new Error(`No replay archive at ${url}.`);
  }
  return new Uint8Array(await new Response(result.stream).arrayBuffer());
}

export async function prepareReplayArchive(
  sandbox: SandboxSession,
  archive: { commit: string; url: string },
  fetchArchive: (url: string) => Promise<Uint8Array> = readArchive
): Promise<string | null> {
  let bytes: Uint8Array;
  try {
    bytes = await fetchArchive(archive.url);
  } catch (error) {
    return `The replay archive could not be read: ${error instanceof Error ? error.message : String(error)}`;
  }
  await sandbox.writeBinaryFile({ content: bytes, path: ARCHIVE_PATH });
  const unpacked = await boundedRun(sandbox, {
    command: `rm -rf ${WORKTREE} && mkdir -p ${WORKTREE} && tar -xzf ${ARCHIVE_PATH} -C ${WORKTREE} && rm -f ${ARCHIVE_PATH} && test ! -e ${WORKTREE}/.git`,
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
        worktree: WORKTREE,
      },
      null,
      2
    ),
    path: REPOSITORY_MARKER,
  });
  return null;
}

export async function prepareReplayWorkspace(
  initiator: SessionAuthContext | null | undefined,
  getSandbox: () => Promise<SandboxSession>
) {
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
  const { archive } = await readReplayState(session.runId, session.caseKey);
  const error = await prepareReplayArchive(await getSandbox(), archive);
  if (error) {
    return { refusal: { code: "replay_archive_unavailable", error } };
  }
  return {
    current: { repository: REPLAY_REPOSITORY, source: "explicit" as const },
    previous: null,
    replaced: false as const,
    repository: REPLAY_REPOSITORY,
    reused: false as const,
    success: true as const,
    worktree: WORKTREE,
  };
}
