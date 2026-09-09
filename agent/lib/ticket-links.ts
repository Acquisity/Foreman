/** Linear's stable issue route does not depend on the mutable title slug. */
export const ticketUrl = (id: string) =>
  `https://linear.app/acquisity/issue/${id}`;

const TICKET = /(?<![\w/-])ENG-[1-9]\d*(?![\w/-])/g;
const TOKEN =
  /```[\s\S]*?```|`[^`\n]+`|\[[^\]\n]*\]\(<?https?:\/\/[^\s)>]+>?\)|<https?:\/\/[^>\n]+>|https?:\/\/[^\s<>]+/g;
const MARKDOWN_LINK = /^\[([^\]\n]*)\]\(<?(https?:\/\/[^\s)>]+)>?\)$/;
const SLACK_LINK = /^<(https?:\/\/[^|>]+)\|([^>]+)>$/;
const CODE_TICKET = /^`ENG-[1-9]\d*`$/;

/** Protect URLs and existing links; link every prose occurrence, including repeats. */
export function linkTickets(
  text: string,
  format: "markdown" | "slack" = "markdown"
) {
  const link = (label: string, url: string) =>
    format === "slack" ? `<${url}|${label}>` : `[${label}](${url})`;
  const prose = (value: string) =>
    value.replace(TICKET, (id) => link(id, ticketUrl(id)));
  let offset = 0;
  let result = "";
  for (const token of text.matchAll(TOKEN)) {
    result += prose(text.slice(offset, token.index));
    const [value] = token;
    const markdown = MARKDOWN_LINK.exec(value);
    const slack = SLACK_LINK.exec(value);
    if (markdown) {
      result += link(markdown[1], markdown[2]);
    } else if (slack) {
      result += link(slack[2], slack[1]);
    } else if (CODE_TICKET.test(value)) {
      result += prose(value.slice(1, -1));
    } else {
      result += value;
    }
    offset = token.index + value.length;
  }
  return result + prose(text.slice(offset));
}
