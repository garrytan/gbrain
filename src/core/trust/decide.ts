/**
 * Entry point for owner trust decisions (#5575 ENG-4): loads every checked
 * handler, then dispatches. Callers (the confirm/review ops, the CLI, IPC
 * delegation) establish the owner's confirmation first (trust/confirm.ts).
 */
import { SUPERSEDE_HANDLER_ACTIONS } from './supersede-handlers.ts';
import { PAGE_HANDLER_ACTIONS } from './page-handlers.ts';
import type { TrustProposalAction } from './proposals.ts';

/** Every trust proposal action with a registered accept handler. */
export const TRUST_HANDLER_ACTIONS: readonly TrustProposalAction[] = [...SUPERSEDE_HANDLER_ACTIONS, ...PAGE_HANDLER_ACTIONS];

export { decideTrustProposal } from './proposals.ts';
