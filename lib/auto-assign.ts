/**
 * Inbox auto-assignment mode. `round-robin` hands each brand-new conversation to
 * the next workspace member in rotation (the atomic assign_next_member RPC owns
 * the index math); `manual` leaves conversations unassigned.
 */
export const AUTO_ASSIGN_MODES = ["manual", "round-robin"] as const;
export type AutoAssignMode = (typeof AUTO_ASSIGN_MODES)[number];

export function isValidAutoAssignMode(mode: string): mode is AutoAssignMode {
  return (AUTO_ASSIGN_MODES as readonly string[]).includes(mode);
}
