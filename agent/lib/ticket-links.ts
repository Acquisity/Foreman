/** Linear's stable issue route does not depend on the mutable title slug. */
export const ticketUrl = (id: string) =>
  `https://linear.app/acquisity/issue/${id}`;

const TICKET = /(?<![\w/-])ENG-[1-9]\d*(?![\w/-])/g;
const TOKEN =
  /```[\s\S]*?```|`[^`\n]+`|\[[^\]\n]*\]\(|<https?:\/\/[^>\n]+>|https?:\/\/[^\s<>]+/g;
const MARKDOWN_LINK = /^\[([^\]\n]*)\]\(<?(https?:\/\/[^\s>]+?)>?\)$/;
const SLACK_LINK = /^<(https?:\/\/[^|>]+)\|([^>]+)>$/;
const CODE_TICKET = /^`ENG-[1-9]\d*`$/;

// Find the complete destination instead of treating a URL's first ')' as its end.
function markdownLinkEnd(text: string, start: number) {
  let depth = 1;
  let angle = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n") {
      break;
    }
    if (char === "\\") {
      index += 1;
    } else if (char === "<") {
      angle = true;
    } else if (char === ">") {
      angle = false;
    } else if (!angle && char === "(") {
      depth += 1;
    } else if (!angle && char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return start;
}

/** Protect URLs and existing links; link every prose occurrence, including repeats. */
export function linkTickets(
  text: string,
  format: "markdown" | "slack" = "markdown"
) {
  const link = (label: string, url: string) =>
    format === "slack"
      ? `<${url.replaceAll("|", "%7C")}|${label.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}>`
      : `[${label}](${url})`;
  const prose = (value: string) =>
    value.replace(TICKET, (id) => link(id, ticketUrl(id)));
  let offset = 0;
  let result = "";
  const tokens = new RegExp(TOKEN);
  // biome-ignore lint/suspicious/noUnnecessaryConditions: exec returns null after the last token; lastIndex advances through complete links.
  for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
    result += prose(text.slice(offset, token.index));
    let [value] = token;
    if (value.startsWith("[") && value.endsWith("](")) {
      tokens.lastIndex = markdownLinkEnd(text, tokens.lastIndex);
      value = text.slice(token.index, tokens.lastIndex);
    }
    const markdown = MARKDOWN_LINK.exec(value);
    const slack = SLACK_LINK.exec(value);
    if (markdown) {
      result += markdown[1].includes("|")
        ? value
        : link(markdown[1], markdown[2]);
    } else if (slack) {
      result += format === "slack" ? value : link(slack[2], slack[1]);
    } else if (CODE_TICKET.test(value)) {
      result += prose(value.slice(1, -1));
    } else {
      result += value;
    }
    offset = token.index + value.length;
  }
  return result + prose(text.slice(offset));
}
