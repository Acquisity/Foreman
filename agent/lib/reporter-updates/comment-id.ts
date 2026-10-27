import { createHash } from "node:crypto";
import type { LedgerStage } from "./copy.js";

const VARIANTS = "89ab";

export const commentIdFor = (issue: string, stage: LedgerStage): string => {
  const hex = createHash("sha256")
    .update(`reporter-update:${issue}:${stage}`)
    .digest("hex");
  const variant = VARIANTS[Number.parseInt(hex.slice(16, 17), 16) % 4];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
