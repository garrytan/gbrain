/**
 * Onboarding PR 2 (d7): the first-session suggestion's status and stop path for agents on every supported native
 * client. onboarding_status reads (read scope); onboarding_off writes only the suggestion's own record (write scope,
 * no new grant) and only for the bound install's owner: the trusted local CLI, a stdio server bound to no member or
 * to the owner, or a credential bound to the owner member. It reads the stored record back before it answers, so
 * the agent says "stopped" only when the store agrees. Never import from '../operations.ts' here (cycle).
 * The CLI front door is `gbrain onboarding status|off` (src/commands/onboarding.ts); these ops are hidden there.
 */
import { opError, type Operation, type OperationContext } from './contract.ts';

/** True when the caller is the bound install's owner (see the header). */
export async function callerIsInstallOwner(ctx: OperationContext): Promise<boolean> {
  if (ctx.remote === false) return true;
  const { memberIdentityFor } = await import('../access/caller.ts');
  const { ownerMemberId } = await import('../access/owner.ts');
  const localStdio = ctx.transport === 'stdio' && !ctx.auth?.principal && ctx.auth?.member === undefined;
  let identity: string[];
  try {
    identity = await memberIdentityFor(ctx.engine, {
      ...(ctx.auth?.member !== undefined ? { member: ctx.auth.member } : {}),
      ...(ctx.auth?.principal ? { principal: ctx.auth.principal } : localStdio ? { principal: { kind: 'local_stdio', id: 'local' } } : {}),
      ...(ctx.stdioMember !== undefined ? { stdioMember: ctx.stdioMember } : {}),
    });
  } catch { return false; }
  const member = identity.find(p => p.startsWith('member:'))?.slice('member:'.length);
  if (localStdio && !member) {
    const { stdioMemberId } = await import('../access/caller.ts');
    return (ctx.stdioMember ?? await stdioMemberId(ctx.engine, { strict: true }).catch(() => 'unreadable')) === null;
  }
  return !!member && member === await ownerMemberId(ctx.engine);
}

/** The local hook's newest startup outcome; only for a caller on this machine (CLI or stdio), never over HTTP. */
async function lastSession(ctx: OperationContext) {
  if (ctx.remote !== false && ctx.transport !== 'stdio') return undefined;
  const { readFirstSessionOutcomes } = await import('../context/session-start-sections.ts');
  return readFirstSessionOutcomes().at(-1) ?? null;
}

export async function onboardingStatusFor(ctx: OperationContext) {
  const { firstSessionStatus } = await import('../onboard/first-session.ts');
  const status = await firstSessionStatus(ctx.engine);
  const last = await lastSession(ctx);
  return { ...status, ...(last !== undefined ? { last_session: last } : {}) };
}

const onboarding_status: Operation = {
  name: 'onboarding_status',
  mutating: false,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description:
    'Whether the first-session suggestion is armed on this brain, and why not when it is off: not_new_install, not_personal, window_expired, ' +
    'sessions_exhausted or stopped. On this machine it also names the newest startup session\'s outcome (delivered, not_due, serve_not_ready, ' +
    'no_ipc, deadline, trimmed and the rest). Reads only; onboarding_off turns it off.',
  params: {},
  scope: 'read',
  annotations: { readOnlyHint: true },
  cliHints: { name: 'onboarding-status', hidden: true },
  handler: async (ctx) => onboardingStatusFor(ctx),
};

const onboarding_off: Operation = {
  name: 'onboarding_off',
  mutating: true,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description:
    'Turn the first-session suggestion off for this install (the owner only). Writes only the suggestion\'s own record, then reads it back: ' +
    'say it stopped only when verified is true. First-run settings and safety notices are not affected.',
  params: {},
  scope: 'write',
  annotations: { idempotentHint: true },
  cliHints: { name: 'onboarding-off', hidden: true },
  handler: async (ctx) => {
    if (!await callerIsInstallOwner(ctx)) {
      throw opError('onboarding_owner_only', 'Only the owner of this install can turn the first-session suggestion off, and this connection is not bound to the owner, so nothing changed.',
        'Ask the brain owner to run gbrain onboarding off on the brain host.', { why: 'The suggestion is the owner\'s; a member-bound connection reads it but never changes it.' });
    }
    const { stopFirstSession } = await import('../onboard/first-session.ts');
    return stopFirstSession(ctx.engine, { by: ctx.remote === false ? 'cli' : 'mcp' });
  },
};

export const onboardingOperations: Operation[] = [onboarding_status, onboarding_off];
