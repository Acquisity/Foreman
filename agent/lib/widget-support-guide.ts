import { PRODUCT_GUIDE } from "./widget-product-guide.js";

/**
 * Support facts Aaron confirmed (ENG-15044 round 10) that the help center does
 * not state. Hand-maintained: widget-product-guide.ts is generated and must not
 * be edited by hand. The unpaid-inbox line follows Acquisity's weekly
 * audit-cmr-domain-subscriptions job and unpaid-managed-domain-cancellation.
 */
const SUPPORT_FACTS = `# Support facts

Confirmed by Acquisity's support team. They count as product facts, like the guide that follows.

- Writing copy for a prospect or a campaign is not something an account investigation does. Point the customer to the AI Consultant: the "Chat" side of the Home/Chat toggle at the top of the left sidebar.
- A message like "You're back with Acquisity Foreman" is a system notice: the chat with a person ended and the AI took over again.
- A first email, and every other sequence step, comes from the campaign's email copy and its variants, never from the AI SDR. The AI SDR only writes replies after a prospect responds, and its persona comes from its Knowledge Base and its Assigned Call Handler. When a wrong name or wrong text shows up, first find out which of the two it is in.
- Done-for-you inboxes in Error, with Reconnect failing because the mailbox was not found: first check whether they were cancelled for non-payment. A weekly check flags unpaid done-for-you domains, and after a grace period Acquisity cancels them: the domain is suspended, its inboxes go to Error with the saved connection error "Mailbox cancelled after unpaid cleanup", and the order shows as cancelled. Read each inbox's saved connection error (widget_inbox_health), the order's status and domain errors (widget_provisioning_status) and the order's billing subscriptions (widget_billing_summary) before anything else. Reconnect cannot bring back a cancelled mailbox.
- "No email accounts connected" can show while accounts are connected and sending fine. It is a known display bug: trust the inbox read over that message.
- Lead credits and website credits come from one shared pool. Check how many credits went to websites before calling a credit gap a double count.
- A published site without its own domain gets a free generic web address that the customer does not control. A custom domain is a separate purchase.
- In the Cold Email Writer, the referrer fields are required. Generic values do not block sending, but they should name a real person at the customer's company.
- When a sending account was connected directly on a Legacy plan, never tell the customer someone at their company set it up: it may have been set up and managed for them.`;

/** What the investigator, the reply composer and the judge read as product knowledge. */
export const SUPPORT_GUIDE = `${SUPPORT_FACTS}\n\n${PRODUCT_GUIDE}`;
