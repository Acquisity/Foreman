import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { get } from "@vercel/blob";
import type { SessionAuthContext } from "eve/context";
import type { SandboxSession } from "eve/sandbox";
import { REPOSITORY_MARKER } from "../repository.js";
import { boundedRun } from "../sandbox-deadline.js";
import { readReplayState } from "./backend.js";
import { replaySessionOf } from "./mode.js";

export const REPLAY_REPOSITORY = "Acquisity/Acquisity";
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

export const replayCommitNote = (commit: string) =>
  `Triage replay: ${WORKTREE} holds Acquisity at commit ${commit}, as it was when the ticket was filed. Investigate it with grep, glob and read_file. GitHub tools and the network are closed in a replay, so their absence is expected and is no reason to stop repository work. The archive has no .git, so record ${commit} as the commit read instead of running git rev-parse HEAD.`;

export async function prepareReplayArchive(
  sandbox: SandboxSession,
  archive: { commit: string; url: string },
  fetchArchive: (url: string) => Promise<Uint8Array> = readArchive
): Promise<string | null> {
  const prepared = await boundedRun(sandbox, {
    command: `test -d ${WORKTREE} && grep -q '"replayCommit": "${archive.commit}"' ${REPOSITORY_MARKER}`,
  });
  if (prepared.exitCode === 0) {
    return null;
  }
  let bytes: Uint8Array;
  try {
    bytes = await fetchArchive(archive.url);
  } catch (error) {
    return `The replay archive could not be read: ${error instanceof Error ? error.message : String(error)}`;
  }
  const scratch = `${dirname(WORKTREE)}/.triage-replay-${randomUUID()}`;
  await sandbox.writeBinaryFile({ content: bytes, path: `${scratch}.tar.gz` });
  const unpacked = await boundedRun(sandbox, {
    command: `mkdir -p ${scratch} && tar -xzf ${scratch}.tar.gz -C ${scratch} && rm -f ${scratch}.tar.gz && test ! -e ${scratch}/.git && { mv -T ${scratch} ${WORKTREE} 2>/dev/null || rm -rf ${scratch}; } && test -d ${WORKTREE}`,
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
      success: false as const,
    };
  }
  const { archive } = await readReplayState(session.runId, session.caseKey);
  const error = await prepareReplayArchive(await getSandbox(), archive);
  if (error) {
    return {
      refusal: { code: "replay_archive_unavailable", error },
      success: false as const,
    };
  }
  return {
    commit: archive.commit,
    current: { repository: REPLAY_REPOSITORY, source: "explicit" as const },
    note: replayCommitNote(archive.commit),
    previous: null,
    replaced: false as const,
    repository: REPLAY_REPOSITORY,
    reused: false as const,
    success: true as const,
    worktree: WORKTREE,
  };
}
