// Parses a comma-separated list of Slack channel IDs into a Set, trimming
// whitespace and dropping empty entries. Pure so evals can import it without
// triggering the env reads in constants.ts.
export function parseIntakeOnlyChannels(raw: string | undefined): Set<string> {
  const channels = new Set<string>();
  if (raw === undefined) {
    return channels;
  }
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed !== "") {
      channels.add(trimmed);
    }
  }
  return channels;
}
