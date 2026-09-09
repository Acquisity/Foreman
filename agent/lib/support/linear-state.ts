import { createHash } from "node:crypto";
import { z } from "zod";
import { providerData } from "./conversation.js";

export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const linearSnapshot = z.record(
  z.string(),
  z.object({
    fingerprint: z.string(),
    status: z.string(),
  })
);
export type LinearSnapshot = z.infer<typeof linearSnapshot>;
export const linkedIssue = z
  .object({
    description: z.string().nullable().optional(),
    id: z.string().min(1).max(100),
    status: z.string(),
    title: z.string().optional(),
  })
  .passthrough();

/** Ignore bookkeeping fields, but retain evidence that may change the support next step. */
export function issueSnapshot(
  issue: z.infer<typeof linkedIssue>,
  comments: unknown[]
) {
  const stable = (items: unknown) =>
    Array.isArray(items)
      ? items
          .map((item) =>
            JSON.stringify(item, (_key, value: unknown) =>
              value && typeof value === "object" && !Array.isArray(value)
                ? Object.fromEntries(
                    Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
                  )
                : value
            )
          )
          .sort()
      : items;
  return {
    fingerprint: digest({
      attachments: stable(issue.attachments),
      comments: comments
        .map((comment) => {
          const parsed = z
            .object({
              body: z.string(),
              id: z.string(),
              resolvedAt: z.string().nullable().optional(),
            })
            .parse(comment);
          return JSON.stringify(parsed);
        })
        .sort((a, b) => a.localeCompare(b)),
      description: issue.description ?? "",
      relations:
        issue.relations &&
        typeof issue.relations === "object" &&
        !Array.isArray(issue.relations)
          ? Object.fromEntries(
              Object.entries(issue.relations)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([kind, items]) => [kind, stable(items)])
            )
          : stable(issue.relations),
      releases: stable(issue.releases),
      status: issue.status,
      title: issue.title ?? "",
    }),
    status: issue.status,
  };
}

export function writtenIssueId(data: unknown) {
  return z.object({ id: z.string().min(1).max(100) }).parse(providerData(data))
    .id;
}
