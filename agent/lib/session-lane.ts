import type { SessionAuthContext } from "eve/context";
import { EXECUTOR_DISCOVERY } from "./executor/instructions.js";
import { isSupportAuth } from "./support/auth.js";
import { SUPPORT_DISCOVERY, SUPPORT_PROMPT } from "./support/instructions.js";
import { isFrontDoor } from "./trust.js";
import {
  WIDGET_DISCOVERY,
  WIDGET_GUIDE,
  widgetInstructions,
} from "./widget-instructions.js";
import { isWidgetSupport } from "./widget-scope.js";

/**
 * Composition choices for a signed session lane; provider policy remains in
 * Executor dispatch. Memory follows the event's current auth, because the
 * front-door route is decided per event while the initiator is fixed when the
 * session starts, and the memory tools check the current auth.
 */
export function sessionLane(
  auth: SessionAuthContext | null | undefined,
  current: SessionAuthContext | null | undefined = auth
) {
  if (isWidgetSupport(auth)) {
    return {
      broadExecutor: false,
      customer: true,
      // The guide sits with the discovery text, ahead of the per-session scope,
      // so the cached system prefix is the same for every widget session.
      discovery: `${WIDGET_DISCOVERY}\n\n${WIDGET_GUIDE}`,
      instructions: widgetInstructions(auth),
      repository: false,
    };
  }
  return isSupportAuth(auth)
    ? {
        broadExecutor: false,
        customer: false,
        discovery: SUPPORT_DISCOVERY,
        instructions: SUPPORT_PROMPT,
        repository: false,
      }
    : {
        broadExecutor: true,
        customer: false,
        discovery: EXECUTOR_DISCOVERY,
        instructions: "",
        memory: !isFrontDoor(current),
        repository: true,
      };
}
