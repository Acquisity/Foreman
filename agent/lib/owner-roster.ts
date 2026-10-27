import { AREA_KEYS, AREAS } from "./owner-map.js";

const PREAMBLE = `# Area-routing roster

Do not load this reference unless \`STAGE 4 COMPLETE: evidence record ready\` existed before this file was opened and Stage 6 reached area routing before its duplicate or engineering-handoff branch. If either gate is absent, stop reading and return to the unfinished stage. This is the owner map Stage 6 routing and the \`engineering-handoff\` master assignee follow, and the same map lives in code, so \`decide_triage\` and \`route_ticket\` agree with it. Give names exactly as written: the routing tool refuses any assignee who is not on this list. An area that fits nothing goes to James Keeble. A support owner is never a developer: tickets for Aaron Fraga are refunds, concessions and the support widget.
`;

const sentence = (text: string): string =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

export const renderRoster = (): string => {
  const rows = AREA_KEYS.map((key) => {
    const area = AREAS[key];
    const lane = area.lane === "support" ? " (support)" : "";
    return `- ${sentence(area.description)} (\`${key}\`, label \`${area.label}\`): ${area.owner}${lane}`;
  });
  return `${PREAMBLE}\n${rows.join("\n")}\n`;
};
