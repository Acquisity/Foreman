// Slack channel IDs: an uppercase letter class then base-32-ish characters.
// Anything else in the env list is a typo (a channel name, a quoted value),
// and silently keeping it would leave the gate off for the channel it was
// meant to cover, so it is dropped loudly instead.
const CHANNEL_ID_PATTERN = /^[CGD][A-Z0-9]{7,}$/u;

// Parses a comma-separated list of Slack channel IDs into a Set, trimming
// whitespace and dropping empty entries. Pure so tests can import it without
// triggering the env reads in constants.ts.
export function parseIntakeOnlyChannels(raw: string | undefined): Set<string> {
  const channels = new Set<string>();
  if (raw === undefined) {
    return channels;
  }
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim().toUpperCase();
    if (trimmed === "") {
      continue;
    }
    if (CHANNEL_ID_PATTERN.test(trimmed)) {
      channels.add(trimmed);
    } else {
      console.warn(
        `SLACK_INTAKE_ONLY_CHANNELS: ignoring "${trimmed}", not a Slack channel ID.`
      );
    }
  }
  return channels;
}
