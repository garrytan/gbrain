/**
 * GBRA-582 item 9 (leaver handover, PR 2): \`gbrain access member handover <member>\`, the CLI over core/access/handover.ts.
 * Preview by default; --yes --expect <plan_hash> applies exactly what the preview showed; --status <id> settles the Git
 * publication; --undo <id> previews (then --yes --expect applies) the reversal once the member is enabled again.
 */
import type { BrainEngine } from '../core/engine.ts';
import type { OperationContext } from '../core/ops/contract.ts';
import { usageError } from '../cli/cli-error.ts';
import { loadConfig } from '../core/config.ts';
import { applyHandover, getHandover, handoverStatus, parseChoices, previewHandover, previewUndo, refuseHandoverWrites, type HandoverPreview, type HandoverRecord } from '../core/access/handover.ts';

const VALUE_FLAGS = new Set(['--set', '--expect', '--undo', '--status']);

function values(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith(name + '=')) { out.push(a.slice(name.length + 1)); continue; }
    if (a !== name) continue;
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) throw usageError(name + ' requires a value.', 'Put the value right after the flag, as in ' + name + ' VALUE.');
    out.push(v);
    i++;
  }
  return out;
}

const one = (args: string[], name: string) => values(args, name).at(-1);

function memberArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i]!)) { i++; continue; }
    if (!args[i]!.startsWith('--')) return args[i];
  }
  return undefined;
}

const print = (json: boolean, value: unknown, human: () => string[]) => console.log(json ? JSON.stringify(value, null, 2) : human().join('\n'));
const plain = (p: string) => (p.startsWith('member:') ? p.slice(7) : p);
const list = (xs: string[]) => xs.map(plain).join(', ') || 'none';

function previewLines(p: HandoverPreview, command: string): string[] {
  const groupLine = (g: HandoverPreview['groups'][number]) => '  ' + g.group + ' (' + plain(g.choice) + '): ' + g.count + (g.sample.length ? ' - ' + g.sample.join(', ') + (g.count > g.sample.length ? ', ...' : '') : '') + (g.note ? ' (' + g.note + ')' : '');
  return [
    'Handover of ' + p.member + ' (' + p.member_status + '), owner ' + (p.owner ?? 'not set'),
    ...p.groups.map(groupLine),
    '  Members gaining access: ' + list(p.gains) + (p.owner_gains ? ' (the owner gains ' + p.owner_gains + ' page(s))' : ''),
    '  Members losing access: ' + list(p.losses),
    ...(p.opens_to_source_readers ? ['  Opens pages to every caller entitled to the source, unbound credentials included.'] : []),
    '  Bound credentials: ' + p.bound_credentials + (p.bound_credentials ? ' (refused while the member is off; gbrain auth list shows them)' : ''),
    '  Groups of the leaver: ' + list(p.leaver_groups),
    ...p.warnings.map(w => '  Note: ' + w),
    p.items.length ? 'Nothing written. Apply with: ' + command + ' --yes --expect ' + p.plan_hash : 'Nothing to hand over.',
  ];
}

function recordLines(r: HandoverRecord): string[] {
  const done = r.items.filter(i => i.outcome === 'done').length;
  return [
    'Handover ' + r.id + (r.undo_of ? ' (undo of ' + r.undo_of + ')' : '') + ' of ' + r.member_id + ': ' + r.state + ', ' + done + ' of ' + r.items.length + ' item(s) written',
    ...(r.commits.length ? ['  Rule commits: ' + r.commits.map(c => c.slice(0, 12)).join(', ')] : []),
    ...(r.git ? ['  Git: ' + Object.entries(r.git).map(([k, v]) => k + ' ' + v).join(', ')] : []),
    ...(r.state === 'publishing' ? ['  Page files are still being committed; check with gbrain access member handover --status ' + r.id] : []),
    ...(r.state === 'applied' && !r.undo_of ? ['  Undo once the member is enabled again: gbrain access member handover ' + r.member_id + ' --undo ' + r.id] : []),
  ];
}

export async function handoverCmd(engine: BrainEngine, args: string[], json: boolean): Promise<void> {
  const status = one(args, '--status');
  if (status) {
    const r = await handoverStatus(engine, status);
    return print(json, r, () => recordLines(r));
  }
  const undo = one(args, '--undo');
  const sets = values(args, '--set');
  const yes = args.includes('--yes');
  const expect = one(args, '--expect');
  let member = memberArg(args);
  if (yes || undo) refuseHandoverWrites(engine, undo ? 'undo' : 'apply');
  if (undo && !member) member = (await getHandover(engine, undo)).member_id;
  if (!member) throw usageError('access member handover needs a member id.', 'gbrain access member handover <member> [--set <group>=<choice>]... [--yes --expect <hash>] [--undo <id>] [--status <id>]');
  if (undo && sets.length) throw usageError('--undo restores what the handover recorded; it takes no --set.', 'gbrain access member handover ' + member + ' --undo ' + undo);
  const command = ['gbrain access member handover', member, ...sets.map(s => '--set ' + s), ...(undo ? ['--undo ' + undo] : [])].join(' ');
  if (yes) {
    if (!expect) throw usageError('access member handover --yes needs --expect <plan_hash> from the preview.', 'Preview first: ' + command);
    const ctx = { engine, config: loadConfig() ?? { engine: engine.kind }, logger: { info: console.error, warn: console.error, error: console.error }, dryRun: false, remote: false } as OperationContext;
    const record = await applyHandover(engine, member, { ctx, expect, previewCommand: command, ...(undo ? { undo: await getHandover(engine, undo) } : {}),
      onProgress: json ? undefined : (done, total) => process.stderr.write('[handover] ' + done + '/' + total + ' page(s)\n') });
    return print(json, record, () => recordLines(record));
  }
  if (undo) {
    const p = await previewUndo(engine, undo);
    return print(json, { ...p, applied: false }, () => [
      'Undo of handover ' + undo + ' (' + p.handover.member_id + '): ' + p.items.length + ' item(s) restore their recorded readers' + (p.changed_since ? ', ' + p.changed_since + ' changed since and stay as they are' : ''),
      ...p.items.slice(0, 5).map(i => '  ' + (i.kind === 'page' ? i.source_id + ':' + i.slug + ' -> ' + list(i.to ?? []) : i.kind === 'rule' ? 'rule ' + i.source_id + ':' + i.prefix + ' -> ' + list(i.to ?? []) : 'source ' + i.source_id + ' -> ' + i.to)),
      p.items.length ? 'Nothing written. Apply with: ' + command + ' --yes --expect ' + p.plan_hash : 'Nothing to undo.',
    ]);
  }
  const p = await previewHandover(engine, member, parseChoices(sets));
  return print(json, { ...p, applied: false }, () => previewLines(p, command));
}
