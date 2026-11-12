/**
 * GST-363 (PR 2): shared_stdio_binding. config mcp.stdio_member binds every stdio session on this host to one member,
 * so a harness several people talk to (OpenClaw or Hermes, found by sharedStdioHarness) then reads as that member,
 * private pages included, for whoever is asking it. Fails when the key is set and such a harness is installed, with the
 * unset command as the fix; ok when the key is set and no shared harness is installed; not applicable while it is unset
 * or the brain serves one person (every caller is then that person, so the binding takes nothing from anyone).
 */
import type { Check } from '../../doctor.ts';
import { agentFix, checkError, infoCheck } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { stdioMemberId } from '../../../core/access/caller.ts';
import { sharedStdioHarness } from '../../setup-serves.ts';
import { brainServes } from '../../../core/access/serves.ts';

const NAME = 'shared_stdio_binding';

async function runSharedStdioBinding(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const member = await stdioMemberId(connectedEngine(ctx));
    if (!member) {
      checks.push(infoCheck(NAME, 'Not applicable: config mcp.stdio_member is unset, so no stdio session on this host reads as a member.', 'not_applicable'));
      return checks;
    }
    if ((await brainServes(connectedEngine(ctx))).serves === 'one') {
      checks.push(infoCheck(NAME, `Not applicable: this brain serves one person, so stdio sessions reading as ${member} (config mcp.stdio_member) read nothing kept from anyone else.`, 'not_applicable'));
      return checks;
    }
    const harness = sharedStdioHarness();
    if (!harness) {
      checks.push({ name: 'shared_stdio_binding', status: 'ok', details: { stdio_member: member, shared_harness: null },
        message: `Every stdio session on this host reads as ${member} (config mcp.stdio_member), and no harness several people talk to (OpenClaw, Hermes) is installed here.` });
      return checks;
    }
    checks.push({ name: 'shared_stdio_binding', status: 'fail', details: { stdio_member: member, shared_harness: harness },
      message: `config mcp.stdio_member binds every stdio session on this host to ${member}, and ${harness} is installed here, so ${harness} reads as ${member}, private pages included, for whoever is asking it.`,
      fix: agentFix(['gbrain', 'config', 'unset', 'mcp.stdio_member'], `Unbinds stdio on this host, so ${harness} stops reading as ${member}. Ask the user first: a harness only ${member} uses then reads unbound until it gets its own key.`, NAME,
        { ask_user: true, docs: 'docs/guides/setup.md#a-brain-that-serves-several-people' }) });
  } catch (error) {
    checks.push(checkError(NAME, `run ${NAME}`, error));
  }
  return checks;
}

export const sharedStdioBindingEntry: DoctorEntry = {
  name: 'shared_stdio_binding',
  emits: ['shared_stdio_binding'],
  run: runSharedStdioBinding,
};
