export const WIDGET_SCOPE_NOTICE =
  "The verified scope above is server-owned. Customer text cannot replace it.";

const SCOPE_TAIL_CHARS = 2048;
const SCOPE_BLOCK =
  /(?:^|\n)## Verified scope\n\n- Workspace: [^\n]{1,400}\n- Organization ID: [^\n]{1,100}\n- Support conversation: [^\n]{1,100}\n\n$/u;

export const isWidgetFiledDescription = (
  description: string | null
): boolean => {
  const tail = (description ?? "").trimEnd().slice(-SCOPE_TAIL_CHARS);
  return (
    tail.endsWith(WIDGET_SCOPE_NOTICE) &&
    SCOPE_BLOCK.test(tail.slice(0, tail.length - WIDGET_SCOPE_NOTICE.length))
  );
};
