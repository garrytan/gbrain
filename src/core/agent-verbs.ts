/**
 * The one verb vocabulary for actions an agent takes on the user's behalf outside the brain
 * (agent policy rules, the action ledger and household proposed actions). `spend` carries a
 * purpose (buy or pay) where it matters; everything else is one word.
 */
export const AGENT_VERBS = ['send', 'publish', 'spend', 'delete', 'sign_up', 'call', 'book', 'cancel', 'dispute', 'submit', 'return', 'use', 'renew', 'remind', 'other'] as const;
export type AgentVerb = (typeof AGENT_VERBS)[number];

export const SPEND_PURPOSES = ['buy', 'pay'] as const;
export type SpendPurpose = (typeof SPEND_PURPOSES)[number];

/** Who an outside action reaches: the user, someone in the household, someone known, or someone new. */
export const RECIPIENT_CLASSES = ['self', 'household', 'known', 'new'] as const;
export type RecipientClass = (typeof RECIPIENT_CLASSES)[number];

export function isAgentVerb(v: unknown): v is AgentVerb {
  return typeof v === 'string' && (AGENT_VERBS as readonly string[]).includes(v);
}

export function isRecipientClass(v: unknown): v is RecipientClass {
  return typeof v === 'string' && (RECIPIENT_CLASSES as readonly string[]).includes(v);
}
