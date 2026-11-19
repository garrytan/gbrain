/**
 * `gbrain identity` (GST-3216): shows who gbrain takes the brain's owner to be and every signal behind it. Trusted local
 * CLI only: it prints personal identifiers, so no MCP operation or thin client reads it.
 */
import type { BrainEngine } from '../core/engine.ts';
import { usageError } from '../cli/cli-error.ts';
import { listMembers } from '../core/access/members.ts';
import { ownerIdentity, type OwnerIdentity } from '../core/identity/owner.ts';

const HELP = `Usage: gbrain identity [--member <id>] [--json]

Shows who gbrain takes the brain's owner to be, worked out from what the brain
already stores: the owner member's email (gbrain access owner), the account of
each Google source the owner owns, and the owner's linked external ids. Nothing
here is a setting. A name never counts; two members never share an identifier.

  --member <id>   Show another member's own identity (each member is their own "me")
  --json          Machine-readable output
`;

const BASIS: Record<OwnerIdentity['entity']['basis'], string> = {
  identifier_page: 'the one person page whose email is an owner identifier',
  member_page: "the owner member's own page",
  reserved_page: 'the reserved owner page (no person page carries an owner identifier)',
};

export function renderIdentity(id: OwnerIdentity): string {
  const lines = [`Owner: ${id.member ?? 'the local owner (no owner member is set)'}`, `Owner page: ${id.entity.slug}${id.entity.source_id ? ` (source ${id.entity.source_id})` : ''}, ${BASIS[id.entity.basis]}`];
  lines.push(id.identifiers.length ? 'Identifiers:' : 'Identifiers: none yet');
  for (const i of id.identifiers) {
    lines.push(`  ${i.kind === 'member_link' ? `${i.system} id` : 'email'} ${i.value}  (${i.kind === 'member_email' ? 'member email' : i.kind === 'google_account' ? `Google source ${i.source_id}` : 'linked id'})`);
  }
  for (const c of id.conflicts) {
    lines.push(c.kind === 'identifier_shared'
      ? `Conflict: ${c.value} is claimed by ${c.members.join(' and ')}, so it counts for neither.`
      : `Conflict: ${c.pages.length} person pages carry an owner email (${c.pages.map(p => p.slug).join(', ')}), so none is used; keep the email on one page.`);
  }
  for (const s of id.skipped_sources) {
    lines.push(`Not counted: Google source ${s.source_id} (${s.reason === 'bound_to_other_member' ? 'it belongs to another member' : 'it is bound to no member on a brain with several people; bind it with gbrain access member source add <member> <source>'}).`);
  }
  return lines.join('\n');
}

export async function runIdentity(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return; }
  const at = args.indexOf('--member');
  const member = at >= 0 ? args[at + 1] : undefined;
  if (at >= 0 && (!member || member.startsWith('--'))) throw usageError('gbrain identity: --member needs a member id.', 'Pass a member id from gbrain access member list, as in gbrain identity --member <id>.');
  if (member && !(await listMembers(engine)).some(m => m.id === member)) throw usageError(`gbrain identity: no member has the id ${member}.`, 'Pass a member id from gbrain access member list, as in gbrain identity --member <id>.');
  const id = await ownerIdentity(engine, member ? { member } : {});
  console.log(args.includes('--json') ? JSON.stringify(id, null, 2) : renderIdentity(id));
}
