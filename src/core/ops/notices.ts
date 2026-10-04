/**
 * `mute_notice` (agent operator contract v1, A6): persist a dismissal for a
 * coaching/info notice. Remote callers mute for their own client only; the
 * trusted local CLI (`gbrain notices mute`) mutes for the owner globally.
 */
import type { Operation } from './contract.ts';
import { opError } from './contract.ts';
import { NOTICE_CODES } from '../error-registry.ts';
import { setNoticeMuted } from '../notice-ledger.ts';

const MUTEABLE = Object.entries(NOTICE_CODES).filter(([, e]) => e.kind === 'coaching' || e.kind === 'info').map(([c]) => c).sort();

const mute_notice: Operation = {
  name: 'mute_notice',
  mutating: true,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Stop a coaching or info notice from appearing for this client (or unmute it with muted: false). '
    + 'Safety, degraded and ask notices cannot be muted.',
  params: {
    code: { type: 'string', required: true, description: 'Notice code, the word after `[gbrain notice` in the block.', enum: MUTEABLE },
    muted: { type: 'boolean', description: 'false unmutes. Default true.' },
  },
  scope: 'write',
  handler: async (ctx, p) => {
    const code = String(p.code ?? '');
    if (!MUTEABLE.includes(code)) {
      throw opError('invalid_params', `Notice ${code || '(empty)'} cannot be muted.`,
        `Mute one of: ${MUTEABLE.join(', ')}. Safety, degraded and ask notices always show.`);
    }
    const principal = ctx.remote === false ? undefined : ctx.auth?.clientId ?? 'stdio';
    const muted = p.muted !== false;
    const list = setNoticeMuted(code, muted, principal);
    return { code, muted, scope: principal ? 'client' : 'owner', muted_codes: list };
  },
};

export const noticesOperations: Operation[] = [mute_notice];
export const MUTEABLE_NOTICE_CODES: readonly string[] = MUTEABLE;
