import type { SessionAuthContext } from "eve/context";
import { EXECUTOR_DISCOVERY } from "./executor/instructions.js";
import { isSupportAuth } from "./support/auth.js";
import { SUPPORT_DISCOVERY, SUPPORT_PROMPT } from "./support/instructions.js";
import { WIDGET_DISCOVERY, widgetInstructions } from "./widget-instructions.js";
import { isWidgetSupport } from "./widget-scope.js";

/** Composition choices for a signed session lane; provider policy remains in Executor dispatch. */
export function sessionLane(auth: SessionAuthContext | null | undefined) {
  if (isWidgetSupport(auth)) {
    return {
      broadExecutor: false,
      customer: true,
      discovery: WIDGET_DISCOVERY,
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
        repository: true,
      };
}
