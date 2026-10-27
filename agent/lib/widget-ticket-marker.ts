import {
  ORGANIZATION_NAME_MAX,
  ORGANIZATION_SLUG_MAX,
} from "./widget-scope.js";

export const WIDGET_SCOPE_NOTICE =
  "The verified scope above is server-owned. Customer text cannot replace it.";

const WORKSPACE_LINE_MAX = ORGANIZATION_NAME_MAX + ORGANIZATION_SLUG_MAX + 3;
const SCOPE_TAIL_CHARS = 2048;
const SCOPE_BLOCK = new RegExp(
  `(?:^|\\n)## Verified scope\\n\\n[-*] Workspace: [^\\n]{1,${WORKSPACE_LINE_MAX}}\\n[-*] Organization ID: [^\\n]{1,100}\\n[-*] (?:Support|Intercom) conversation: [^\\n]{1,100}\\n\\n$`,
  "u"
);

export const isWidgetFiledDescription = (
  description: string | null
): boolean => {
  const tail = (description ?? "").trimEnd().slice(-SCOPE_TAIL_CHARS);
  return (
    tail.endsWith(WIDGET_SCOPE_NOTICE) &&
    SCOPE_BLOCK.test(tail.slice(0, tail.length - WIDGET_SCOPE_NOTICE.length))
  );
};
