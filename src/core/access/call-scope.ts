/**
 * GST-2904 (GBRA-592, decisions K and N): whether `gbrain import --calls` may keep a new call to its attendees.
 *
 * Scoping applies only on a brain that serves two or more real people: config access.serves is not `one` and at least
 * two enabled person-kind members exist (group-chat audience members never count, so a personal brain whose assistant
 * sits in group chats is untouched). Where it applies, a call is kept to the owner plus its attendees only when every
 * caller that could be the owner's own still reads it afterwards (the plan's owner-read table). Otherwise the import
 * stays open, exactly as before, and says why with the calls_not_scoped notice:
 *
 *   - owner_unset: config access.owner_member names nobody, so no reader list could name the owner;
 *   - owner_inactive: it names a member that is not enabled now;
 *   - unbound_readers: a token or OAuth client bound to no person still reads the brain (in grace, opted to read
 *     unscoped, or on a host that does not enforce binding), and could be the owner's own assistant;
 *   - stdio_unbound: a local stdio server bound to nobody still reads (grace, or enforcement off): a harness entry
 *     `gbrain setup` wrote without --stdio-member, or a harness several people talk to (OpenClaw, Hermes), while
 *     config mcp.stdio_member is unset.
 *
 * A connection that is already refused reads nothing today, so it never blocks. Everything here is database state plus
 * the harness entries setup wrote on this machine, so a repo-less brain behaves the same.
 */
import type { BrainEngine } from '../engine.ts';
import type { Action, Notice } from '../agent-output.ts';
import { readServesPolicy, SERVES_KEY } from '../search/private-visibility.ts';
import { listMembers, type MemberRecord } from './members.ts';
import { ownerView } from './owner.ts';
import { REQUESTER_SCOPE_GRACE_DAYS, unscopedConnections } from './requester-scope.ts';
import { stdioMemberId } from './caller.ts';
import { stdioBindRoute } from './stdio-bind-route.ts';

export const CALLS_NOT_SCOPED = 'calls_not_scoped';
export type CallsNotScopedReason = 'owner_unset' | 'owner_inactive' | 'unbound_readers' | 'stdio_unbound';
export const CALLS_NOT_SCOPED_REASONS: readonly CallsNotScopedReason[] = ['owner_unset', 'owner_inactive', 'unbound_readers', 'stdio_unbound'];

/** A local stdio connection bound to nobody: the harness, and the setup command that binds it without its member (null for a shared harness). */
export interface UnboundStdio { harness: string; name?: string; argv: string[] | null }

export type CallScopeGate =
  | { applies: false }
  | { applies: true; scoped: true; owner: string; members: MemberRecord[] }
  | { applies: true; scoped: false; reason: CallsNotScopedReason; notice: Notice };

const DOCS = 'docs/guides/repair.md#calls-not-scoped';

function notice(why: string, fix: Action): Notice {
  return { code: CALLS_NOT_SCOPED, kind: 'safety', why, fix: { ...fix, docs: DOCS } };
}

const userFix = (argv: string[], why: string, verify: string[], inputs?: Action['inputs']): Action =>
  ({ argv, consent: [], actor: 'user', why, verify: { argv: verify }, requires_exclusive: false, ...(inputs ? { inputs } : {}) });

/**
 * Whether new calls in this brain are kept to their attendees. `unboundStdio` lists the local stdio connections bound
 * to nobody (the import reads them from this machine's harness entries; tests pass their own).
 */
export async function callScopeGate(engine: BrainEngine, unboundStdio: () => UnboundStdio[], nowMs = Date.now()): Promise<CallScopeGate> {
  const serves = await readServesPolicy(engine);
  const explicitOne = ((await engine.getConfig(SERVES_KEY)) ?? '').trim().toLowerCase() === 'one';
  const members = await listMembers(engine);
  const people = members.filter(m => m.status === 'enabled' && m.kind === 'person');
  if (explicitOne || people.length < 2) return { applies: false };
  const view = await ownerView(engine);
  if (view.inactive) {
    const id = view.inactive.value;
    return { applies: true, scoped: false, reason: 'owner_inactive', notice: notice(
      `New calls were imported open to everyone who reads their source, as before: the brain owner "${id}" is not an enabled member now (${view.inactive.reason}), so no reader list could name the owner. Enable the owner; the next import keeps new calls to their attendees.`,
      userFix(['gbrain', 'access', 'member', 'enable', id], 'Enables the owner member, so the next call import keeps each call to the owner and its attendees.', ['gbrain', 'access', 'owner', '--json'])) };
  }
  if (!view.owner) {
    const only = people.length === 1 ? people[0]!.id : null;
    return { applies: true, scoped: false, reason: 'owner_unset', notice: notice(
      `New calls were imported open to everyone who reads their source, as before: this brain serves several people and names no owner, so no reader list could keep a call to the owner and its attendees. Name the owner; the next import keeps new calls to their attendees.`,
      userFix(['gbrain', 'access', 'owner', 'set', only ?? '<MEMBER>'], 'Names the brain owner, who reads every call kept to its attendees.', ['gbrain', 'access', 'owner', '--json'],
        only ? undefined : [{ name: 'MEMBER', how: `Ask the user which member owns the brain: ${people.map(p => p.id).join(', ')}.` }])) };
  }
  const owner = view.owner;
  const found = await unscopedConnections(engine, nowMs);
  const reading = (found?.connections ?? []).filter(c => c.state !== 'refused');
  if (reading.length) {
    const first = reading[0]!;
    const argv = first.argv.map(a => a === '<MEMBER>' ? owner : a);
    const list = reading.map(c => `${c.connection} (${c.state}): ${c.argv.map(a => a === '<MEMBER>' ? owner : a).join(' ')}`).join('; ');
    return { applies: true, scoped: false, reason: 'unbound_readers', notice: notice(
      `New calls were imported open to everyone who reads their source, as before: ${reading.length} connection(s) bound to no person still read this brain and might be the owner's own assistant, which would lose every call kept to its attendees. Tie each one that is the owner's to ${owner}, and each other one to the person it serves: ${list}. The next import then keeps new calls to their attendees.`,
      userFix(argv, `Ties ${first.connection} to the owner ${owner}, if it is the owner's; another person's connection is tied to that person instead.`, argv.includes('--token') ? ['gbrain', 'access', 'check', ...argv.slice(argv.indexOf('--token'), argv.indexOf('--token') + 2)] : ['gbrain', 'access', 'serves', '--json'])) };
  }
  const stdioReads = !serves.enforce || (serves.since !== null && Math.floor(nowMs / 1000) < serves.since + REQUESTER_SCOPE_GRACE_DAYS * 24 * 3600);
  if (stdioReads && !(await stdioMemberId(engine))) {
    const unbound = unboundStdio();
    if (unbound.length) {
      const first = unbound[0]!;
      const argv = first.argv ? [...first.argv, '--stdio-member', owner] : stdioBindRoute(owner).argv.map(a => a === '<MEMBER>' ? owner : a === '<HARNESS>' ? first.harness : a);
      const how = first.argv ? `Tie it to the owner ${owner} with ${argv.join(' ')}. ` : stdioBindRoute(owner).text;
      return { applies: true, scoped: false, reason: 'stdio_unbound', notice: notice(
        `New calls were imported open to everyone who reads their source, as before: the ${unbound.map(u => u.harness).join(', ')} stdio connection on this machine is bound to nobody and still reads this brain, and it might be the owner's own assistant. ${how}The next import then keeps new calls to their attendees.`,
        userFix(argv, `Binds the ${first.harness} stdio connection to the owner ${owner}, so it reads every call kept to its attendees.`, ['gbrain', 'access', 'serves', '--json'])) };
    }
  }
  return { applies: true, scoped: true, owner, members };
}

