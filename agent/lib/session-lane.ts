import type { SessionAuthContext } from "eve/context";
import { EXECUTOR_DISCOVERY } from "./executor/instructions.js";
import { isSupportAuth } from "./support/auth.js";
import { SUPPORT_DISCOVERY, SUPPORT_PROMPT } from "./support/instructions.js";

/** Composition choices for a signed session lane; provider policy remains in Executor dispatch. */
export function sessionLane(auth: SessionAuthContext | null | undefined) {
  return isSupportAuth(auth)
    ? {
        broadExecutor: false,
        discovery: SUPPORT_DISCOVERY,
        instructions: SUPPORT_PROMPT,
        repository: false,
      }
    : {
        broadExecutor: true,
        discovery: EXECUTOR_DISCOVERY,
        instructions: "",
        repository: true,
      };
}
