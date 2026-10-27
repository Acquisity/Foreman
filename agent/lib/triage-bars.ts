export const BARS = {
  /** Below this, money versus product is unclear and the model follows the leaning. */
  askKind: 0.7,
  classification: 0.6,
  /** Below this, an existing investigation is not reused. */
  continuation: 0.6,
  /** A billing verdict below this is left to a person. */
  discretion: 0.7,
  /** A done claim without near-certain evidence is flagged. */
  doneClaim: 0.8,
  /** A duplicate closes the ticket, so it needs a near-certain match. */
  duplicate: 0.8,
  /** Below this, staying quiet on a requester follow-up is not trusted. */
  followUp: 0.6,
  /** Below this, a claim the reply makes is flagged as not shown. */
  grounded: 0.5,
  /** Below this, a hotlane call goes to a person instead of the fast lane. */
  incident: 0.6,
  path: 0.6,
  /** Below this, the priority band takes the higher neighbour. */
  priorityBand: 0.6,
  /** Below this, the project is left unset and the area decides the owner. */
  project: 0.6,
  /** A root cause label is only added when the match is clear. */
  rootCauseLabel: 0.6,
  /** Yes/no signals that only add a label or raise a floor. */
  signal: 0.5,
  /** Below this, a follow-up is not trusted to be only a status move. */
  statusOnly: 0.7,
  /** Below this, the claim is treated as unproven. */
  verdict: 0.6,
} as const;
