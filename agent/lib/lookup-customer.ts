import { z } from "zod";
import { parseReadQueryResult } from "./planetscale.js";

/**
 * Fixed PlanetScale coordinates for the production database. The identity
 * lookup never lets the model pick a branch or database.
 */
/** Membership rows fetched per lookup; `truncated` reports when the cap was hit. */
export const MEMBERSHIP_LIMIT = 200;

export const PRODUCTION_READ_QUERY_ARGS = {
  branch: "main",
  database: "acquisity",
  organization: "acquisity",
  postgres_database_name: "postgres",
} as const;

/**
 * Customer email as the model supplies it: trimmed, lowercased, one `@`, no
 * whitespace, quotes, or backslashes, so the literal below cannot break out of
 * its quotes even before {@link buildLookupCustomerQuery} doubles apostrophes.
 */
export const customerEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^\s@'"\\]+@[^\s@'"\\]+$/u, "Expected one customer email address.");

/**
 * The one identity query. Column and table names were read from
 * `packages/db/src/schema/{auth,organization}.ts` in `Acquisity/Acquisity`
 * (`user`, `member`, `organization`, snake_case columns). Named columns only;
 * no credential-shaped column is selected. Soft-deleted memberships are
 * excluded so a removed workspace is never pinned.
 */
export function buildLookupCustomerQuery(email: string): string {
  const literal = email.replace(/'/gu, "''");
  return [
    "select u.id as user_id, u.email, u.name as user_name, u.created_at as user_created_at,",
    "       m.role, o.id as organization_id, o.name as organization_name, o.created_at as organization_created_at",
    'from "user" u',
    "left join member m on m.user_id = u.id and m.deleted_at is null",
    "left join organization o on o.id = m.organization_id",
    `where lower(u.email) = '${literal}'`,
    "order by o.created_at",
    `limit ${MEMBERSHIP_LIMIT}`,
  ].join("\n");
}

const text = z.union([z.string(), z.number()]).transform(String);
const rowSchema = z.looseObject({
  email: text,
  organization_created_at: text.nullish(),
  organization_id: text.nullish(),
  organization_name: text.nullish(),
  role: text.nullish(),
  user_created_at: text.nullish(),
  user_id: text,
  user_name: text.nullish(),
});

export const membershipSchema = z.object({
  organizationCreatedAt: z.string().nullable(),
  organizationId: z.string(),
  organizationName: z.string().nullable(),
  role: z.string().nullable(),
  userId: z.string(),
});

export const lookupCustomerResultSchema = z.object({
  ambiguous: z.boolean(),
  error: z.string().optional(),
  found: z.boolean(),
  memberships: z.array(membershipSchema),
  pinnedOrganizationId: z.string().nullable(),
  /** The membership cap was hit, so the list may be incomplete. */
  truncated: z.boolean(),
  user: z
    .object({
      createdAt: z.string().nullable(),
      email: z.string(),
      id: z.string(),
      name: z.string().nullable(),
    })
    .nullable(),
});

export type LookupCustomerResult = z.infer<typeof lookupCustomerResultSchema>;

const EMPTY: LookupCustomerResult = {
  ambiguous: false,
  found: false,
  memberships: [],
  pinnedOrganizationId: null,
  truncated: false,
  user: null,
};

/**
 * Runs the fixed identity query through `run` and shapes the rows.
 *
 * `pinnedOrganizationId` is set only when exactly one live membership exists;
 * more than one sets `ambiguous` and leaves the pin to the requester. The same
 * email can exist once per partner (`user_email_partner_idx`), so memberships
 * carry `userId` and `user` is the first row's user.
 */
export async function lookupCustomer(
  email: string,
  run: (query: string) => Promise<string>
): Promise<LookupCustomerResult> {
  let parsed: z.infer<typeof rowSchema>[];
  try {
    const { rows } = parseReadQueryResult(
      await run(buildLookupCustomerQuery(email))
    );
    parsed = rows.map((row) => rowSchema.parse(row));
  } catch (error) {
    return {
      ...EMPTY,
      error: error instanceof Error ? error.message : "Identity lookup failed.",
    };
  }

  const [first] = parsed;
  if (!first) {
    return EMPTY;
  }

  const memberships = parsed.flatMap((row) =>
    row.organization_id
      ? [
          {
            organizationCreatedAt: row.organization_created_at ?? null,
            organizationId: row.organization_id,
            organizationName: row.organization_name ?? null,
            role: row.role ?? null,
            userId: row.user_id,
          },
        ]
      : []
  );

  // The same email can exist once per partner, so one user row per email is
  // not guaranteed; a pin needs exactly one user and exactly one membership.
  const userCount = new Set(parsed.map((row) => row.user_id)).size;
  const single = userCount === 1 && memberships.length === 1;
  return {
    ambiguous: userCount > 1 || memberships.length > 1,
    found: true,
    memberships,
    pinnedOrganizationId: single
      ? (memberships[0]?.organizationId ?? null)
      : null,
    truncated: parsed.length >= MEMBERSHIP_LIMIT,
    user: {
      createdAt: first.user_created_at ?? null,
      email: first.email,
      id: first.user_id,
      name: first.user_name ?? null,
    },
  };
}
