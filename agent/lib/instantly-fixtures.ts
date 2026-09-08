import assert from "node:assert/strict";
import type {
  OperationRequest,
  ProviderResult,
} from "./executor/operations.js";
export const ADMIN_ID = "24f5c554-bf6c-4f51-a909-d25d9617cff9";
export const MEMBER_ID = "019e050a-b40f-7d29-ba21-67bfd9d99788";
export const WORKSPACE_ID = "e05cbe7b-67db-4b07-b712-46b9365dc83f";
export const SECOND_WORKSPACE_ID = "019e050a-b40f-7d29-ba21-67c1bc8062b2";
export const MAX_TEST_RESPONSE_BYTES = 256 * 1024;
export const AMBIGUOUS_WORKSPACE =
  /More than one accepted Instantly subworkspace/u;
export const NO_ACCEPTED_WORKSPACE = /No accepted Instantly subworkspace/u;
export const REPEATED_CURSOR = /repeated a Workspace Group pagination cursor/u;
export const TOO_MANY_GROUP_PAGES = /too many Workspace Group pages/u;
export const WRONG_ADMIN_WORKSPACE = /configured IBG admin workspace/u;
export const INSTANTLY_TIMEOUT =
  /^Instantly did not respond within 15 seconds\.$/u;
export const INSTANTLY_UNREACHABLE = /^Instantly could not be reached\.$/u;

export const member = (
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> => ({
  admin_workspace_id: ADMIN_ID,
  admin_workspace_name: "IBG",
  id: MEMBER_ID,
  status: "accepted",
  sub_workspace_id: WORKSPACE_ID,
  sub_workspace_name: "Rick Livingston's Workspace",
  ...overrides,
});

export const json = (
  data: unknown,
  status = 200,
  headers: Partial<Record<string, string>> = {}
): Promise<ProviderResult> =>
  Promise.resolve({
    data,
    status,
    ...(headers["Retry-After"] || headers["retry-after"]
      ? { retryAfter: headers["Retry-After"] ?? headers["retry-after"] }
      : {}),
  });
export const inputOf = (
  request: OperationRequest | undefined
): Record<string, unknown> => {
  assert.ok(request);
  return request.input;
};
export const uuidFor = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
