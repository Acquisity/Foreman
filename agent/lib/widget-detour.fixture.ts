/**
 * Preview conversation 741aab58 (2026-09-26): asked how to add inboxes, sent a
 * screenshot of the Email Accounts page that also showed a re-authentication
 * warning, and was walked through reconnecting instead. The reading is a
 * reconstruction; the real one is not logged.
 */
export const detourReading =
  "Email Accounts page of the Cold Email Agent. Buttons: Add New Inboxes, Import. Warning banner: 'Google needs re-authentication'.";

export const detourTurns = [
  {
    role: "customer" as const,
    text: "hey where can i add new inboxes for cold email campaigns/",
  },
  {
    role: "assistant" as const,
    text: "Go to the Marketing group in the left menu and click Cold Email Agent. Click Email Accounts at the top of the page, then click Add New Inboxes.",
  },
  {
    role: "customer" as const,
    text: `ok im here. now what?\n\n${detourReading}`,
  },
  {
    role: "assistant" as const,
    text: "Since you are on the Email Accounts page and see the Google needs re-authentication warning, click the account to open its settings, then click Reconnect.",
  },
  {
    role: "customer" as const,
    text: "what does that have to do with adding inboxes for my campaign?",
  },
  {
    role: "assistant" as const,
    text: "Resolving an account error or reconnection is important because an inbox with connection issues cannot send your campaign emails until it is fixed and working properly.",
  },
  { role: "customer" as const, text: "ah ok. ok i reconnected now what?" },
  {
    role: "assistant" as const,
    text: "While reconnecting, the inbox shows Reconnect in Progress, and once successful, its status returns to Active.",
  },
];

export const detourGoal = "where can i add new inboxes";

/**
 * Preview conversation 5fc15d15 (2026-09-26): asked to buy inboxes, got steps
 * starting at the Cold Email Agent, then sent a screenshot of its campaigns
 * page, whose setup checklist highlighted Review inboxes, and was sent to that
 * checklist instead of the next step. The reading is a reconstruction.
 */
export const stepsReading =
  "[Screenshot the customer attached, as read by an image model]\nScreen: Cold Email Agent, All Campaigns page. Tabs: Campaigns, Email Accounts, Leads. Buttons: New Campaign, Search. A setup checklist card lists: Connect your inboxes, Review inboxes, Create your first campaign.\nWhat stands out: The setup checklist is incomplete; Review inboxes is highlighted as the next item.";

export const stepsTurns = [
  {
    role: "customer" as const,
    text: "can i buy more inboxes to add to a campaign?",
  },
  {
    role: "assistant" as const,
    text: "Yes, you can buy more inboxes and then add them to a campaign. First, go to Cold Email Agent, open Email Accounts, and click Add New Inboxes to buy the inboxes you need [1]. Once they are ready, open your campaign, go to Options, then Email accounts, and click Add or remove accounts to add them [2].",
  },
];

export const stepsLatest =
  "i found the cold email agent where do i go from here?";
