/**
 * Lane 5 (O2): onboarding job proposals for agents. propose_jobs reads (read scope) the jobs src/core/onboard/propose.ts
 * finds; propose_decide records the owner's accept or decline for one signal in the first-session record (write scope,
 * no new grant) and reads it back. Both answer only the install's owner (callerIsInstallOwner: the trusted local CLI, a
 * stdio server bound to no member or to the owner, or a credential bound to the owner member); anyone else gets
 * propose_owner_only and nothing is read or changed. The CLI front door is `gbrain propose` (src/commands/propose.ts);
 * these ops are hidden there. Never import from '../operations.ts' here (cycle).
 */
import { opError, type Operation, type OperationContext } from './contract.ts';

/**
 * The owner's own unnarrowed view: the install's owner, and for a remote call no audience it speaks for, no attested
 * actor and no labelled-only grant (an owner credential narrowed to a group would otherwise see the owner's pages).
 */
async function requireOwner(ctx: OperationContext, action: string): Promise<void> {
  const { callerIsInstallOwner } = await import('./onboarding.ts');
  const { currentCallerAccess } = await import('../search/private-visibility.ts');
  const acc = currentCallerAccess();
  const narrowed = ctx.remote !== false && (!!acc.audience?.length || !!acc.actor || acc.labelledOnly);
  if (!narrowed && await callerIsInstallOwner(ctx)) return;
  throw opError('propose_owner_only', `Only the owner of this install can ${action} job proposals, and this connection is not bound to the owner, so nothing was ${action === 'read' ? 'read' : 'changed'}.`,
    'Ask the brain owner to run gbrain propose on the brain host.', { why: 'Job proposals read the owner\'s mail, calendar, open loops and agent history; a member-bound connection never sees them.' });
}

const propose_jobs: Operation = {
  name: 'propose_jobs',
  mutating: false,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description:
    'Jobs your agent could take on, found in data already in the brain with no model call: people waiting on the user, threads they owe a reply, ' +
    'recurring meetings with no prep page, bulk senders they never wrote to, and the same question asked in two agents. Each job has a count, the ' +
    'pages it rests on, a sentence, and the installed skill or gbrain command that does it. The owner only. Offer one job at a time; ' +
    'propose_decide records the user\'s yes or no.',
  params: {
    days: { type: 'number', description: 'How many days back to look (1-90, default 7).' },
  },
  scope: 'read',
  annotations: { readOnlyHint: true },
  cliHints: { name: 'propose-jobs', hidden: true },
  handler: async (ctx, p) => {
    await requireOwner(ctx, 'read');
    const { federatedSearchScope } = await import('./context.ts');
    const scope = federatedSearchScope(ctx);
    const { proposeJobs } = await import('../onboard/propose.ts');
    return proposeJobs(ctx.engine, { days: p.days as number | undefined, sourceIds: scope.sourceIds ?? (scope.sourceId ? [scope.sourceId] : null), forCaller: ctx.remote !== false });
  },
};

const propose_decide: Operation = {
  name: 'propose_decide',
  mutating: true,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description:
    'Record the user\'s answer to one proposed job (the owner only): accepted or declined, by signal. A declined job is not offered again at session ' +
    'start. Writes only the first-session record, then reads it back: say it was recorded only when verified is true.',
  params: {
    signal: { type: 'string', required: true, enum: ['waiting_on_you', 'owe_reply', 'meeting_prep', 'repeat_question', 'bulk_senders'], description: 'The job\'s signal, as propose_jobs returns it.' },
    decision: { type: 'string', required: true, enum: ['accepted', 'declined'], description: 'The user\'s answer.' },
  },
  scope: 'write',
  annotations: { idempotentHint: true },
  cliHints: { name: 'propose-decide', hidden: true },
  handler: async (ctx, p) => {
    await requireOwner(ctx, 'answer');
    const { isProposeSignal, setProposalDecision } = await import('../onboard/propose.ts');
    if (!isProposeSignal(p.signal) || (p.decision !== 'accepted' && p.decision !== 'declined')) {
      throw opError('invalid_params', 'signal must be one of waiting_on_you, owe_reply, meeting_prep, repeat_question or bulk_senders, and decision accepted or declined; nothing was recorded.',
        'Pass the signal propose_jobs returned and the user\'s answer.');
    }
    return setProposalDecision(ctx.engine, { signal: p.signal, decision: p.decision, by: ctx.remote === false ? 'cli' : 'mcp' });
  },
};

export const proposeOperations: Operation[] = [propose_jobs, propose_decide];
