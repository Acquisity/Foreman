import { createHash } from "node:crypto";
import type { SessionAuthContext } from "eve/context";
import { defineTool } from "eve/tools";
import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import { PDFDocument, type PDFFont, StandardFonts } from "pdf-lib";
import { z } from "zod";
import { operationPath } from "#lib/executor/bindings.js";
import { executorClient } from "#lib/executor/client.js";
import {
  type ExecutorOutcome,
  invokeProvider,
  type ProviderContext,
} from "#lib/executor/dispatch.js";
import {
  DISPUTE_FILE_SLOTS,
  DISPUTE_TEXT_FIELDS,
  type disputeOperationInputs,
  disputeWireArgs,
  type OperationRequest,
} from "#lib/executor/operations.js";
import { ExecutorError } from "#lib/executor/transport.js";
import { STRIPE_DISPUTES_CHANNEL } from "#lib/stripe-dispute-trigger.js";
import {
  isIntakeOnly,
  isQuestionsOnly,
  isStripeDisputeApproval,
  isStripeDisputeSession,
  isUnattended,
  stripeDisputeIdOf,
} from "#lib/trust.js";

/**
 * The only Stripe dispute write path (ENG-16255).
 *
 * @remarks
 * `check` reads the dispute, `stage` saves evidence with `submit=false`, and
 * `submit` sends `submit=true` with no evidence change. Every call re-reads
 * the dispute first and refuses unless it still needs a response, has never
 * been submitted, and is not past due. There is no close, file link, or
 * refund path: the dispute toolkit binds only the evidence update and the
 * evidence file upload.
 *
 * A person approves every submit. The automatic session a new alert starts
 * can check and stage; only an attended Slack session whose current caller is
 * a person in the disputes channel can submit, and only the exact evidence
 * that person was shown, which the fingerprint pins.
 */

const DISPUTE_ID = /^du_[A-Za-z0-9]{1,64}$/u;
const NEEDS_RESPONSE = new Set(["needs_response", "warning_needs_response"]);
const READ_BYTES = 256 * 1024;
const MAX_FIELD_CHARS = 20_000;
const MAX_TOTAL_CHARS = 150_000;
const MAX_FILE_BYTES = 4_500_000;
const MAX_PAGES = 49;
const MAX_MASTERCARD_PAGES = 19;
const LINK = /https?:\/\/|www\./iu;
const FOREMAN_FIELDS = "foreman_fields";

const MAX_METADATA_CHARS = 500;

type Evidence = Record<string, unknown>;

const disputeSchema = z.looseObject({
  amount: z.number().optional(),
  charge: z.union([z.string(), z.looseObject({ id: z.string() })]).nullish(),
  currency: z.string().optional(),
  evidence: z.record(z.string(), z.unknown()).default({}),
  evidence_details: z
    .looseObject({
      due_by: z.number().nullish(),
      has_evidence: z.boolean().optional(),
      past_due: z.boolean().optional(),
      submission_count: z.number().nullish(),
    })
    .optional(),
  id: z.string(),
  metadata: z.record(z.string(), z.string()).default({}),
  payment_method_details: z
    .looseObject({
      card: z
        .looseObject({
          brand: z.string().nullish(),
          network_reason_code: z.string().nullish(),
        })
        .nullish(),
    })
    .nullish(),
  reason: z.string().optional(),
  status: z.string(),
});
export type StripeDispute = z.infer<typeof disputeSchema>;

const textField = z.enum(DISPUTE_TEXT_FIELDS);
const fileSlot = z.enum(DISPUTE_FILE_SLOTS);

const fileSchema = z.object({
  sections: z
    .array(
      z.object({
        heading: z.string().max(200),
        lines: z.array(z.string().max(2000)).max(2000),
      })
    )
    .min(1)
    .max(50),
  slot: fileSlot,
  title: z.string().max(200),
});
export type EvidenceFile = z.infer<typeof fileSchema>;

/**
 * One flat object rather than a union: a top-level `oneOf` reaches the model
 * provider without `type: "object"`.
 */
export const respondInputSchema = z.object({
  action: z
    .enum(["check", "stage", "submit"])
    .describe(
      "check reads the dispute. stage saves evidence without submitting. submit sends the staged evidence to Stripe, only after a person in the thread approved it."
    ),
  disputeId: z
    .string()
    .describe("The du_ id from the alert's Open in Stripe link."),
  evidence: z
    .partialRecord(textField, z.string().max(MAX_FIELD_CHARS))
    .optional()
    .describe(
      "stage only. Text evidence by Stripe field. Fills empty fields and fields that still hold what Foreman staged earlier; never replaces what Acquisity or a person staged. No links."
    ),
  files: z
    .array(fileSchema)
    .max(DISPUTE_FILE_SLOTS.length)
    .optional()
    .describe(
      "stage only. One PDF per slot, rendered by this tool from plain text sections. Put several items for one slot in several sections. Timestamps and authors go in the lines. Refused when the dispute already holds other files. No links."
    ),
  fingerprint: z
    .string()
    .optional()
    .describe(
      "submit only. The fingerprint stage returned and the ready message showed."
    ),
});
export type RespondInput = z.infer<typeof respondInputSchema>;

export const respondOutputSchema = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
  result: z.unknown().optional(),
});
type RespondOutput = z.infer<typeof respondOutputSchema>;

const refuse = (reason: string): RespondOutput => ({ ok: false, reason });

// --- Who may call it ---------------------------------------------------------

/** A person, not a bot or a schedule, posting in the disputes channel. */
export const isDisputeChannelPerson = (
  auth: SessionAuthContext | null | undefined
): boolean =>
  auth?.authenticator === "slack-webhook" &&
  auth.principalType === "user" &&
  auth.attributes.author_type === "user" &&
  auth.attributes.channel_id === STRIPE_DISPUTES_CHANNEL &&
  !isUnattended(auth) &&
  !isStripeDisputeSession(auth);

const RESTRICTED_REASON =
  "Stripe disputes are not worked from this session. Answer from what you already found and do not mention this restriction.";
const SCOPE_REASON =
  "Stripe disputes are worked only in their alert thread in the disputes channel.";
const DELEGATED_REASON =
  "A delegated task cannot work a Stripe dispute. Return what you found to the root.";
const SUBMIT_REASON =
  "A person approves every submit. Post the ready message and end the turn; a person replies in the thread to approve.";
const APPROVAL_REASON =
  "Submit runs only on a turn whose message is a person's clear go-ahead in this thread, like a tag that says approve. A question, a refusal or a change request is not one. Ask them to tag you and say approve if they want it submitted.";

/** The refusal for this caller and action, or null when it may proceed. */
export const disputeAccessRefusal = (
  auth: {
    current: SessionAuthContext | null;
    initiator?: SessionAuthContext | null;
  },
  action: string | undefined,
  delegated: boolean
): string | null => {
  const initiator = auth.initiator ?? null;
  if (
    isIntakeOnly(auth.current) ||
    isIntakeOnly(initiator) ||
    isQuestionsOnly(auth.current) ||
    isQuestionsOnly(initiator)
  ) {
    return RESTRICTED_REASON;
  }
  if (delegated) {
    return DELEGATED_REASON;
  }
  if (action === "submit") {
    if (!isDisputeChannelPerson(auth.current)) {
      return SUBMIT_REASON;
    }
    return isStripeDisputeApproval(auth.current) ? null : APPROVAL_REASON;
  }
  return isStripeDisputeSession(auth.current) ||
    isDisputeChannelPerson(auth.current)
    ? null
    : SCOPE_REASON;
};

/** Denied, never parked: Slack cannot answer an approval card. */
export const respondStripeDisputePolicy = (
  ctx: ApprovalContext
): ApprovalStatus => {
  const reason = disputeAccessRefusal(
    ctx.session.auth,
    (ctx.toolInput as { action?: string } | undefined)?.action,
    Boolean(ctx.session.parent)
  );
  return reason ? { reason, type: "denied" } : "not-applicable";
};

// --- Dispute facts -----------------------------------------------------------

/** Rule 3: the one line to post and stop on, or null when it can be worked. */
export const disputeStateRefusal = (
  dispute: StripeDispute,
  nowMs: number
): string | null => {
  if (!NEEDS_RESPONSE.has(dispute.status)) {
    return `Dispute ${dispute.id} is ${dispute.status}, so there is nothing to stage or submit.`;
  }
  // Missing safety facts refuse: a write needs Stripe to say it was never
  // submitted and when it is due.
  const count = dispute.evidence_details?.submission_count;
  const dueBy = dispute.evidence_details?.due_by;
  if (
    !(
      typeof count === "number" &&
      typeof dueBy === "number" &&
      Number.isFinite(count) &&
      Number.isFinite(dueBy) &&
      count >= 0
    )
  ) {
    return `Stripe did not report the submission count and deadline for dispute ${dispute.id}, so nothing can be written. Check it in Stripe.`;
  }
  if (count > 0) {
    return `Evidence for dispute ${dispute.id} was already submitted, and Stripe accepts it only once.`;
  }
  if (dispute.evidence_details?.past_due || dueBy * 1000 <= nowMs) {
    return `The response deadline for dispute ${dispute.id} has passed.`;
  }
  return null;
};

/** A text field's value, or a file slot's file id. */
const evidenceValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "object" && value !== null && "id" in value
    ? String(value.id)
    : "";
};

/** The staged evidence in a stable order, empty fields dropped. */
const stagedEvidence = (evidence: Evidence): Record<string, string> =>
  Object.fromEntries(
    Object.keys(evidence)
      .sort()
      .map((key) => [key, evidenceValue(evidence[key])] as const)
      .filter(([, value]) => value !== "")
  );

const shortHash = (value: string, length: number): string =>
  createHash("sha256").update(value).digest("hex").slice(0, length);

/** A short hash of the evidence Stripe holds now. */
export const evidenceFingerprint = (evidence: Evidence): string =>
  shortHash(JSON.stringify(stagedEvidence(evidence)), 16);

/** The hash Foreman records for a value it wrote to one field or slot. */
export const valueHash = (value: string): string => shortHash(value, 8);

/**
 * The fields Foreman wrote that still hold the value it wrote, with that
 * value's hash. A field a person changed since no longer matches, so it is
 * theirs; an unreadable marker owns nothing.
 */
const foremanFields = (dispute: StripeDispute): Record<string, string> => {
  let recorded: unknown;
  try {
    recorded = JSON.parse(dispute.metadata[FOREMAN_FIELDS] ?? "{}");
  } catch {
    return {};
  }
  const parsed = z.record(z.string(), z.string()).safeParse(recorded);
  return Object.fromEntries(
    Object.entries(parsed.success ? parsed.data : {}).filter(
      ([field, hash]) => {
        const current = evidenceValue(dispute.evidence[field]);
        return current !== "" && valueHash(current) === hash;
      }
    )
  );
};

const summary = (dispute: StripeDispute) => ({
  amount: dispute.amount,
  cardBrand: dispute.payment_method_details?.card?.brand ?? null,
  charge:
    typeof dispute.charge === "string"
      ? dispute.charge
      : (dispute.charge?.id ?? null),
  currency: dispute.currency,
  dueBy: dispute.evidence_details?.due_by
    ? new Date(dispute.evidence_details.due_by * 1000).toISOString()
    : null,
  evidence: stagedEvidence(dispute.evidence),
  fingerprint: evidenceFingerprint(dispute.evidence),
  foremanFields: Object.keys(foremanFields(dispute)),
  id: dispute.id,
  networkReasonCode:
    dispute.payment_method_details?.card?.network_reason_code ?? null,
  reason: dispute.reason,
  status: dispute.status,
  stripeLink: `https://dashboard.stripe.com/disputes/${dispute.id}`,
  submissionCount: dispute.evidence_details?.submission_count ?? null,
});

// --- Evidence PDFs -----------------------------------------------------------

const PAGE = { height: 792, margin: 50, width: 612 } as const;
const BODY_SIZE = 10;
const LINE_HEIGHT = 13;
const LINE_BREAK = /\r?\n/u;

// ponytail: the standard Helvetica font encodes WinAnsi only, so anything
// outside Latin-1 becomes "?". Embed a Unicode font if names need it.
const winAnsi = (text: string): string =>
  text
    .replace(/[‘’]/gu, "'")
    .replace(/[“”]/gu, '"')
    .replace(/[–—]/gu, "-")
    .replace(/…/gu, "...")
    .replace(/\t/gu, "  ")
    .replace(/[^\x20-\x7E\xA0-\xFF]/gu, "?");

const wrap = (text: string, font: PDFFont, size: number, width: number) => {
  const lines: string[] = [];
  let line = "";
  for (const word of winAnsi(text).split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width) {
      line = next;
      continue;
    }
    if (line) {
      lines.push(line);
    }
    // A single word wider than the line is cut by characters.
    let rest = word;
    while (font.widthOfTextAtSize(rest, size) > width) {
      let cut = rest.length - 1;
      while (
        cut > 1 &&
        font.widthOfTextAtSize(rest.slice(0, cut), size) > width
      ) {
        cut -= 1;
      }
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  lines.push(line);
  return lines;
};

/** Renders one slot's plain-text sections as a PDF, measured exactly. */
export const renderEvidencePdf = async (
  file: EvidenceFile
): Promise<{ bytes: Uint8Array; pages: number }> => {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const usable = PAGE.width - 2 * PAGE.margin;
  let page = pdf.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - PAGE.margin;
  const draw = (text: string, font: PDFFont, size: number) => {
    const lines = text
      .split(LINE_BREAK)
      .flatMap((part) => wrap(part, font, size, usable));
    for (const line of lines) {
      if (y < PAGE.margin + LINE_HEIGHT) {
        page = pdf.addPage([PAGE.width, PAGE.height]);
        y = PAGE.height - PAGE.margin;
      }
      page.drawText(line, { font, size, x: PAGE.margin, y });
      y -= size + 3;
    }
  };
  draw(file.title, bold, 14);
  for (const section of file.sections) {
    y -= LINE_HEIGHT / 2;
    draw(section.heading, bold, 11);
    for (const line of section.lines) {
      draw(line, regular, BODY_SIZE);
    }
  }
  const bytes = await pdf.save();
  return { bytes, pages: pdf.getPageCount() };
};

// --- Calls -------------------------------------------------------------------

export interface DisputeDeps {
  readonly auth: {
    current: SessionAuthContext | null;
    initiator?: SessionAuthContext | null;
  };
  readonly delegated: boolean;
  readonly now: () => number;
  /** Shared-toolkit reads, returning the raw Stripe object. */
  readonly read: (
    request: OperationRequest
  ) => Promise<{ data: unknown; status: number }>;
  /** Renders one file; tests replace it to reach the byte limit. */
  readonly render?: typeof renderEvidencePdf;
  /** Dispute-toolkit writes. */
  readonly write: (
    operation: keyof typeof disputeOperationInputs,
    input: Record<string, unknown>
  ) => Promise<ExecutorOutcome>;
}

const readDispute = async (
  deps: DisputeDeps,
  disputeId: string
): Promise<StripeDispute> => {
  const response = await deps.read({
    input: { dispute_id: disputeId },
    operation: "stripe.disputes.get",
  });
  if (response.status !== 200) {
    throw new Error(`Stripe dispute read failed with HTTP ${response.status}.`);
  }
  return disputeSchema.parse(response.data);
};

/** The written object, or the reason the write did not land. */
const written = (
  outcome: ExecutorOutcome
): { data: Record<string, unknown> } | { reason: string } => {
  if (!outcome.ok) {
    return {
      reason: `Stripe refused the write (${outcome.error.code}${outcome.error.status ? `, HTTP ${outcome.error.status}` : ""}).`,
    };
  }
  const status = outcome.http?.status ?? 200;
  if (status < 200 || status >= 300 || typeof outcome.data !== "object") {
    return { reason: `Stripe refused the write (HTTP ${status}).` };
  }
  return { data: outcome.data as Record<string, unknown> };
};

const errorReason = (error: unknown): string => {
  if (error instanceof ExecutorError) {
    if (
      error.code === "operation_not_bound" ||
      error.code === "operation_bindings_missing"
    ) {
      return `The Stripe dispute write is not provisioned yet (${error.code}). An operator has to bind it in the foreman-disputes toolkit.`;
    }
    return `Executor could not complete the call (${error.code}).`;
  }
  return error instanceof Error ? error.message : "The call could not run.";
};

const lookupIdentity = async (deps: DisputeDeps, chargeId: string | null) => {
  if (!chargeId) {
    return { error: "The dispute names no charge." };
  }
  try {
    const charge = await deps.read({
      input: { charge_id: chargeId, "expand[]": "refunds" },
      operation: "stripe.charges.get",
    });
    const data = (charge.data ?? {}) as {
      billing_details?: { email?: string | null; name?: string | null };
      customer?: string | null;
    };
    if (charge.status !== 200) {
      return { error: `Stripe charge read failed with HTTP ${charge.status}.` };
    }
    const cardholder = {
      email: data.billing_details?.email ?? null,
      name: data.billing_details?.name ?? null,
    };
    if (!data.customer) {
      return { cardholder, customer: null };
    }
    const customer = await deps.read({
      input: { customer_id: data.customer },
      operation: "stripe.customers.get",
    });
    const record = (customer.data ?? {}) as {
      email?: string | null;
      metadata?: Record<string, string>;
      name?: string | null;
    };
    return {
      cardholder,
      customer:
        customer.status === 200
          ? {
              autumnId: record.metadata?.autumn_id ?? null,
              email: record.email ?? null,
              id: data.customer,
              name: record.name ?? null,
            }
          : {
              error: `Stripe customer read failed with HTTP ${customer.status}.`,
            },
    };
  } catch (error) {
    return { error: errorReason(error) };
  }
};

const check = async (deps: DisputeDeps, dispute: StripeDispute) => {
  const facts = summary(dispute);
  return {
    ok: true,
    result: {
      ...facts,
      identity: await lookupIdentity(deps, facts.charge),
      refusal: disputeStateRefusal(dispute, deps.now()),
    },
  };
};

/** Why this stage request cannot go to Stripe as written, or null. */
const stageRefusal = (
  input: RespondInput,
  dispute: StripeDispute
): string | null => {
  const text = input.evidence ?? {};
  const files = input.files ?? [];
  if (Object.keys(text).length === 0 && files.length === 0) {
    return "Nothing to stage: pass evidence, files, or both.";
  }
  const slots = files.map((file) => file.slot);
  if (new Set(slots).size !== slots.length) {
    return "Each file slot takes one file. Merge items into sections.";
  }
  // Keep what Acquisity or a person staged: only empty fields and fields
  // still holding the value this tool wrote may change.
  const owned = foremanFields(dispute);
  const taken = [...Object.keys(text), ...slots].filter(
    (field) => evidenceValue(dispute.evidence[field]) !== "" && !owned[field]
  );
  if (taken.length) {
    return `Already staged by Acquisity or a person, left as is: ${taken.join(", ")}. Put the extra evidence in an empty field instead.`;
  }
  // Stripe's file limits cover every file on the dispute, and files already
  // there cannot be measured, so new files go only beside none.
  const kept = DISPUTE_FILE_SLOTS.filter(
    (slot) =>
      evidenceValue(dispute.evidence[slot]) !== "" && !slots.includes(slot)
  );
  if (slots.length && kept.length) {
    return `The dispute already holds evidence files (${kept.join(", ")}), so no files were added. Stage the text evidence without files.`;
  }
  const newText = [
    ...Object.values(text),
    ...files.flatMap((file) => [
      file.title,
      ...file.sections.flatMap((section) => [
        section.heading,
        ...section.lines,
      ]),
    ]),
  ];
  if (newText.some((value) => LINK.test(value))) {
    return "Stripe evidence cannot contain links. Quote the text instead.";
  }
  const merged = { ...stagedEvidence(dispute.evidence), ...text };
  const total = DISPUTE_TEXT_FIELDS.reduce(
    (sum, field) => sum + (merged[field]?.length ?? 0),
    0
  );
  return total > MAX_TOTAL_CHARS
    ? `Text evidence would total ${total} characters; Stripe allows ${MAX_TOTAL_CHARS}.`
    : null;
};

const NO_FILES =
  "Stage the text evidence without files and say the files were not attached.";

/** Uploads every file, or none count: the first failure is the reason. */
const uploadFiles = async (
  deps: DisputeDeps,
  rendered: readonly { bytes: Uint8Array; slot: string }[]
): Promise<Record<string, string> | { reason: string }> => {
  const fileIds: Record<string, string> = {};
  for (const { bytes, slot } of rendered) {
    let outcome: ExecutorOutcome;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: one upload at a time, so the first failure stops the rest.
      outcome = await deps.write("stripe.files.create", {
        file: Buffer.from(bytes).toString("base64"),
        purpose: "dispute_evidence",
      });
    } catch (error) {
      return {
        reason: `File upload for ${slot} failed, so nothing was staged. ${errorReason(error)} ${NO_FILES}`,
      };
    }
    const uploaded = written(outcome);
    if ("reason" in uploaded) {
      return {
        reason: `File upload for ${slot} failed, so nothing was staged. ${uploaded.reason} ${NO_FILES}`,
      };
    }
    const { id } = uploaded.data;
    if (typeof id !== "string" || !id.startsWith("file_")) {
      return {
        reason: `File upload for ${slot} returned no file id, so nothing was staged. ${NO_FILES}`,
      };
    }
    fileIds[slot] = id;
  }
  return fileIds;
};

const stage = async (
  deps: DisputeDeps,
  input: RespondInput,
  dispute: StripeDispute
): Promise<RespondOutput> => {
  const refusal = stageRefusal(input, dispute);
  if (refusal) {
    return refuse(refusal);
  }
  const text = input.evidence ?? {};
  const files = input.files ?? [];

  // Render and measure every file before uploading any.
  const rendered = await Promise.all(
    files.map(async (file) => ({
      ...(await (deps.render ?? renderEvidencePdf)(file)),
      slot: file.slot,
    }))
  );
  const bytes = rendered.reduce((sum, file) => sum + file.bytes.length, 0);
  const pages = rendered.reduce((sum, file) => sum + file.pages, 0);
  const pageLimit =
    dispute.payment_method_details?.card?.brand === "mastercard"
      ? MAX_MASTERCARD_PAGES
      : MAX_PAGES;
  if (bytes > MAX_FILE_BYTES) {
    return refuse(
      `Evidence files total ${bytes} bytes; Stripe allows ${MAX_FILE_BYTES}. Trim the sections.`
    );
  }
  if (pages > pageLimit) {
    return refuse(
      `Evidence files total ${pages} pages; this card network allows ${pageLimit}. Trim the sections.`
    );
  }

  // Rendering takes time: the deadline may have passed meanwhile.
  const late = disputeStateRefusal(dispute, deps.now());
  if (late) {
    return refuse(late);
  }

  const fileIds = await uploadFiles(deps, rendered);
  if ("reason" in fileIds && typeof fileIds.reason === "string") {
    return refuse(fileIds.reason);
  }
  // Uploads take time too: check the dispute as it is now before writing.
  const fresh = await readDispute(deps, dispute.id);
  const changed =
    disputeStateRefusal(fresh, deps.now()) ?? stageRefusal(input, fresh);
  if (changed) {
    return refuse(`The dispute changed while files uploaded. ${changed}`);
  }
  const evidence: Record<string, string> = { ...text, ...fileIds };
  const marker = JSON.stringify(
    Object.fromEntries(
      Object.entries({
        ...foremanFields(fresh),
        ...Object.fromEntries(
          Object.entries(evidence).map(([field, value]) => [
            field,
            valueHash(value),
          ])
        ),
      }).sort(([a], [b]) => a.localeCompare(b))
    )
  );
  if (marker.length > MAX_METADATA_CHARS) {
    return refuse(
      `Foreman's record of the fields it wrote would exceed Stripe's ${MAX_METADATA_CHARS} character metadata limit. Stage fewer fields.`
    );
  }
  const update = written(
    await deps.write("stripe.disputes.update", {
      dispute_id: dispute.id,
      evidence,
      metadata: { [FOREMAN_FIELDS]: marker },
      submit: false,
    })
  );
  if ("reason" in update) {
    return refuse(update.reason);
  }
  const readBack = await readDispute(deps, dispute.id);
  return {
    ok: true,
    result: { ...summary(readBack), files: fileIds, pages, staged: true },
  };
};

const submit = async (
  deps: DisputeDeps,
  input: RespondInput,
  dispute: StripeDispute
): Promise<RespondOutput> => {
  if (!input.fingerprint) {
    return refuse(
      "Submit needs the fingerprint from the ready message the person approved."
    );
  }
  const current = evidenceFingerprint(dispute.evidence);
  if (current !== input.fingerprint) {
    return refuse(
      `The evidence changed after the ready message (fingerprint ${current}, approved ${input.fingerprint}). Nothing was submitted. Read it again and post a new ready message.`
    );
  }
  // The same approval always sends the same key, so a retried submit whose
  // first outcome is unknown is replayed by Stripe instead of sent twice.
  const result = written(
    await deps.write("stripe.disputes.update", {
      dispute_id: dispute.id,
      "Idempotency-Key": `foreman-dispute-submit-${dispute.id}-${input.fingerprint}`,
      submit: true,
    })
  );
  if ("reason" in result) {
    return refuse(result.reason);
  }
  const after = disputeSchema.safeParse(result.data);
  return {
    ok: true,
    result: {
      status: after.success ? after.data.status : null,
      stripeLink: `https://dashboard.stripe.com/disputes/${dispute.id}`,
      submissionCount: after.success
        ? (after.data.evidence_details?.submission_count ?? null)
        : null,
      submitted: true,
    },
  };
};

/** The tool body, with every outside call injected. */
export const respondStripeDispute = async (
  input: RespondInput,
  deps: DisputeDeps
): Promise<RespondOutput> => {
  const access = disputeAccessRefusal(deps.auth, input.action, deps.delegated);
  if (access) {
    return refuse(access);
  }
  if (!DISPUTE_ID.test(input.disputeId)) {
    return refuse("disputeId must be a Stripe dispute id (du_...).");
  }
  // A write is bound to the dispute named by the alert at the root of this
  // turn's thread, so a person in another thread cannot stage or approve it.
  if (
    input.action !== "check" &&
    stripeDisputeIdOf(deps.auth.current) !== input.disputeId
  ) {
    return refuse(
      "Work this dispute from its own alert thread. Nothing was written."
    );
  }
  if (input.action !== "stage" && (input.evidence || input.files)) {
    return refuse("Evidence and files are staged with action stage only.");
  }
  try {
    const dispute = await readDispute(deps, input.disputeId);
    if (input.action === "check") {
      return await check(deps, dispute);
    }
    const state = disputeStateRefusal(dispute, deps.now());
    if (state) {
      return refuse(state);
    }
    return input.action === "stage"
      ? await stage(deps, input, dispute)
      : await submit(deps, input, dispute);
  } catch (error) {
    return refuse(errorReason(error));
  }
};

const liveDeps = (
  ctx: ProviderContext & Required<Pick<ProviderContext, "session">>
): DisputeDeps => {
  const client = executorClient(ctx);
  return {
    auth: ctx.session.auth,
    delegated: Boolean(ctx.session.parent),
    now: Date.now,
    read: (request) => client(request, { maxBytes: READ_BYTES }),
    write: (operation, input) =>
      invokeProvider(
        ctx,
        operationPath(operation),
        disputeWireArgs(operation, input)
      ),
  };
};

export default defineTool({
  approval: respondStripeDisputePolicy,
  description:
    "Work one Stripe dispute from its alert thread. check returns the dispute's status, deadline, reason code, card brand, staged evidence with its fingerprint, and the cardholder and Stripe customer identity. stage saves text evidence and PDF evidence files with submit=false, fills only empty fields, and returns the read-back evidence and its fingerprint. submit sends the staged evidence to Stripe once, only after a person in the thread approved that fingerprint. Every action re-checks that the dispute still needs a response. This tool never accepts or closes a dispute and never refunds.",
  async execute(input, ctx) {
    if (ctx.abortSignal.aborted) {
      throw ctx.abortSignal.reason;
    }
    return await respondStripeDispute(input, liveDeps(ctx));
  },
  inputSchema: respondInputSchema,
  outputSchema: respondOutputSchema,
});
