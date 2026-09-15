import type { SessionAuthContext } from "eve/context";
import { type FinContext, finContextSchema } from "./fin-scope.js";

export const FIN_INVESTIGATION_ISSUER = "foreman:fin-investigation";

/** The issuer is the lane boundary; malformed attributes stay in that lane and fail closed. */
export function isFinInvestigation(
  auth: SessionAuthContext | null | undefined
): boolean {
  return auth?.issuer === FIN_INVESTIGATION_ISSUER;
}

/** Read the immutable scope stamped when the investigation session started. */
export function finInvestigationContext(
  auth: SessionAuthContext | null | undefined
): FinContext | null {
  if (!isFinInvestigation(auth)) {
    return null;
  }
  const parsed = finContextSchema.safeParse(auth?.attributes);
  return parsed.success ? Object.freeze(parsed.data) : null;
}

export function requireFinInvestigationContext(
  auth: SessionAuthContext | null | undefined
): FinContext {
  const context = finInvestigationContext(auth);
  if (!context) {
    throw new Error(
      "The verified customer investigation scope is unavailable."
    );
  }
  return context;
}

/** Stamp only server-verified context. Caller text never contributes authority. */
export function finInvestigationAuth(context: FinContext): SessionAuthContext {
  const verified = finContextSchema.parse(context);
  return {
    attributes: { ...verified },
    authenticator: "bearer",
    issuer: FIN_INVESTIGATION_ISSUER,
    principalId: verified.userId,
    principalType: "service",
  };
}
