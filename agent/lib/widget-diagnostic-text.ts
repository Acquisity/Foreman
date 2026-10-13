import { redact } from "#lib/investigation-memory/case.js";

const GENERIC =
  "A diagnostic was recorded; its technical details are unavailable";
// Return authored explanations, never fragments of a provider's error. An unknown
// vendor needs no new exception: unrecognized diagnostics stay generic.
const EXPLANATIONS: readonly (readonly [RegExp, string])[] = [
  [/account_error/i, "The sending provider reported an account error"],
  [
    /request was rejected|api key.*(?:invalid|revoked)/i,
    "The sending-account connection was rejected",
  ],
  [/api connection failed/i, "The sending-account connection failed"],
  [/waiting on .*oauth connection/i, "Waiting for mailbox authorization"],
  [/mailbox cancelled by user/i, "Mailbox cancelled by user"],
  [
    /mailbox removed because the domain subscription ended/i,
    "Mailbox removed because the domain subscription ended",
  ],
  [
    /account_exists/i,
    "Mailbox authorization failed because the account already exists in another workspace",
  ],
  [/mailbox not found/i, "The mailbox could not be found"],
  [/manually fix required/i, "Mailbox authorization requires manual attention"],
  [
    /webhook.*(?:out of sync|out.of.sync)/i,
    "The sending-account connection is out of sync",
  ],
  [/rate.limit/i, "The connection was rate limited"],
  [/billing overage/i, "Mailbox suspended during billing reconciliation"],
  [/accounts unhealthy/i, "Accounts unhealthy"],
  [/bounce protect/i, "Bounce protection paused the campaign"],
  [
    /high bounce rate/i,
    "A high bounce rate paused the campaign; re-verify leads before resuming",
  ],
  [
    /provider reported.*completed.*no emails.*sent/i,
    "The sending provider reported the campaign completed, but no emails were sent",
  ],
  [/account suspended/i, "The sending account was suspended"],
  [
    /scaled into dedicated send window/i,
    "Campaign moved into a dedicated send window",
  ],
  [/paused via public api/i, "Campaign paused through the public API"],
  [
    /subscription.*(?:end|expir|paus)/i,
    "Campaign paused because of its subscription state",
  ],
  [/insufficient funds/i, "Your card has insufficient funds."],
  [/card.*expired|expired.*card/i, "Your card has expired."],
  [/connection.*link.*closed/i, "The payment-account connection was closed."],
  [/payment failed|card.*declined/i, "The payment was declined."],
];
const STATUS_CHANGE =
  /^Campaign status updated to (draft|active|paused|completed|attention_needed|archived)$/i;
const LAUNCH_FAILURE = /^Campaign launch failed:\s*/i;
const TECHNICAL = /<[!/]?[a-z][^>]*>|\b(?:[a-z]*Error|exception)\b|\n\s*at\s/i;

/** Shared diagnostic boundary; customer-authored names and structured emails never pass here. */
export function diagnosticText(
  value: string | null,
  maxChars = 500
): string | null {
  if (value === null) {
    return null;
  }
  const text = redact(value.slice(0, 4000))
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted URL]")
    .replace(
      /"(?:api[_-]?key|secret|password|token)"\s*:\s*"[^"\n]*"/gi,
      '"credential":"[redacted]"'
    )
    .trim();
  if (!text) {
    return null;
  }
  const launch = LAUNCH_FAILURE.test(text);
  const reason = text.replace(LAUNCH_FAILURE, "");
  const status = STATUS_CHANGE.exec(text);
  if (status) {
    return `Campaign status updated to ${status[1].toLowerCase()}`.slice(
      0,
      maxChars
    );
  }
  const explanation = TECHNICAL.test(reason)
    ? GENERIC
    : (EXPLANATIONS.find(([pattern]) => pattern.test(reason))?.[1] ?? GENERIC);
  return (
    launch ? `Campaign launch failed: ${explanation}` : explanation
  ).slice(0, maxChars);
}
