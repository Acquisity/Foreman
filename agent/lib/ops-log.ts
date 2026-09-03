/**
 * Bounded one-line JSON logging for Foreman's lifecycle hooks.
 *
 * The hooks emit a fixed set of scalar fields. Keeping that schema here makes
 * both output size and serialization work bounded: each call performs exactly
 * one descriptor read per allowed field, never enumerates caller-owned data,
 * and never invokes getters or conversion hooks. A malformed value becomes a
 * fixed tag, and a broken formatter or logger is contained locally.
 */
export const OPS_LOG_STRING_LIMIT = 200;
export const OPS_LOG_LINE_LIMIT = 4000;

const TRUNCATION_MARKER = "...";
const OPS_FIELD_KEYS = [
  "code",
  "connection",
  "message",
  "outcome",
  "requests",
  "sessionId",
  "stepIndex",
  "tool",
  "turnId",
] as const;

type OpsField = (typeof OPS_FIELD_KEYS)[number];
export type OpsFields = Partial<Record<OpsField, unknown>>;

const truncate = (value: string): string =>
  value.length > OPS_LOG_STRING_LIMIT
    ? `${value.slice(0, OPS_LOG_STRING_LIMIT)}${TRUNCATION_MARKER}`
    : value;

/** Converts one value without executing caller-controlled conversion code. */
const sanitizeValue = (value: unknown): unknown => {
  if (typeof value === "string") {
    return truncate(value);
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return Number.isFinite(value) || typeof value !== "number"
      ? value
      : "[NonFiniteNumber]";
  }
  if (typeof value === "undefined") {
    return null;
  }
  if (typeof value === "bigint") {
    return "[BigInt]";
  }
  if (typeof value === "function") {
    return "[Function]";
  }
  if (typeof value === "symbol") {
    return "[Symbol]";
  }
  return "[Object]";
};

const fallbackLine = (event: string): string =>
  JSON.stringify({ error: "ops_log_format_failed", event: truncate(event) });

/**
 * Formats one lifecycle record as bounded, one-line JSON. Unknown fields are
 * deliberately ignored; adding a lifecycle field requires extending the
 * allowlist above so the logging surface stays auditable.
 */
export const formatOpsEvent = (
  event: string,
  fields: OpsFields = {}
): string => {
  try {
    const record: Record<string, unknown> = {};
    for (const key of OPS_FIELD_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(fields, key);
      if (descriptor && "value" in descriptor) {
        record[key] = sanitizeValue(descriptor.value);
      }
    }
    record.event = truncate(event);
    const line = JSON.stringify(record);
    return line.length <= OPS_LOG_LINE_LIMIT ? line : fallbackLine(event);
  } catch {
    return fallbackLine(event);
  }
};

export type OpsLogger = (line: string) => void;

/** Emits one lifecycle record without allowing observability to break a turn. */
export const logOpsEvent = (
  event: string,
  fields: OpsFields = {},
  logger: OpsLogger = console.info
): void => {
  try {
    logger(formatOpsEvent(event, fields));
  } catch {
    // Dropped by design: logging failure must never become a lifecycle failure.
  }
};
