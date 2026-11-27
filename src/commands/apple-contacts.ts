/**
 * \`gbrain apple-contacts\`: changes to the owner's Apple Contacts through GBrain Helper's write route (plan GST-3278, PR 1).
 * One change per call, for the owner's own asks through their agent: every call is owner-signed (contacts-write-client.ts)
 * and carries the owner's words as --owner-instruction, which the helper journals.
 *
 *   gbrain apple-contacts write <verb> --card <id> [...] --owner-instruction "<their words>" [--source <id>] [--json]
 *   gbrain apple-contacts status [--source <id>] [--json]
 *
 * Verbs that only add: fill (an empty field), add-value (an email or phone beside the others), create, group-add.
 * Verbs that change or remove what is there: set, remove-value, group-remove, delete, merge. They also need
 * \`apple_contacts.destructive_writes\` = on, which ships off. Every write needs \`apple_contacts.write\` = on (off by
 * default; dry_run prints the request and sends nothing). The helper keeps its own daily limits whatever this sends.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { parseAppleContactsSourceConfig } from '../core/apple-contacts/source-config.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { appleContactsError } from '../core/apple/contacts-client.ts';
import { DESTRUCTIVE_CONFIG_KEY, OWNER_KEY_FILE_CONFIG_KEY, readOwnerKey, sendContactsBatch, WRITE_CONFIG_KEY, type ContactsWriteChange } from '../core/apple/contacts-write-client.ts';
import { CREATE_CARDS_CONFIG_KEY, ENRICH_CONFIG_KEY, proposeEnrichment, readEnrichRecord, WRITE_TOKEN_FILE_CONFIG_KEY } from '../core/apple-contacts/enrich.ts';
import { listSources } from '../core/sources-ops.ts';
import { parsePhoneCountryCode, PHONE_COUNTRY_CODE_CONFIG_KEY } from '../core/phone-key.ts';

export { DESTRUCTIVE_CONFIG_KEY, OWNER_KEY_FILE_CONFIG_KEY, WRITE_CONFIG_KEY };

const ADDITIVE: Record<string, ContactsWriteChange['op']> = { fill: 'fill', 'add-value': 'add_value', create: 'create', 'group-add': 'group_add' };
const DESTRUCTIVE: Record<string, ContactsWriteChange['op']> = { set: 'set', 'remove-value': 'remove_value', 'group-remove': 'group_remove', delete: 'delete', merge: 'merge' };

const HELP = [
  'Usage: gbrain apple-contacts write <verb> --card <id> ... --owner-instruction "<the owner\'s words>" [--source <id>] [--json]',
  '       gbrain apple-contacts status [--source <id>] [--json]',
  '       gbrain apple-contacts enrich status|dry-run [--source <id>] [--json]',
  '',
  'Adds only:   fill --card <id> --field <given_name|family_name|nickname|organization|job_title> --value <v>',
  '             add-value --card <id> --field <emails|phones> --value <v> [--label <work|home|mobile|...>]',
  '             create --fields-json \'{"given_name":"...","emails":[{"label":"work","value":"..."}]}\'',
  '             group-add --card <id> --group <name>',
  'Changes:     set --card <id> --field <f> --value <v> --expect <the value now>',
  '             remove-value --card <id> --field <emails|phones> --value <v>',
  '             group-remove --card <id> --group <name>',
  '             delete --card <id> --expect-json \'<the card as last read, e.g. {"given_name":"...","emails":["..."]}>\'',
  '             merge --card <keep id> --from <remove id>',
  'Change verbs also need: gbrain config set ' + DESTRUCTIVE_CONFIG_KEY + ' on (ships off).',
  'Every write needs: gbrain config set ' + WRITE_CONFIG_KEY + ' on (off by default; dry_run sends nothing).',
  '',
  'Enrichment after each pull fills empty companies and job titles and adds confirmed emails and phones from the brain:',
  '  gbrain config set ' + ENRICH_CONFIG_KEY + ' dry_run|on (off by default); on also needs ' + WRITE_CONFIG_KEY + ' on and ' + WRITE_TOKEN_FILE_CONFIG_KEY + '.',
  '  New cards from Google Contacts also need: gbrain config set ' + CREATE_CARDS_CONFIG_KEY + ' true (off by default).',
  '  enrich status shows the last run; enrich dry-run lists what the next run would send and sends nothing.',
].join('\n');

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function json(raw: string | undefined, what: string): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* refused below */ }
  throw appleContactsError('apple_contacts_bad_request', what + ' must be one JSON object. Nothing was changed.', HELP);
}

async function resolveSource(engine: BrainEngine, wanted: string | undefined) {
  const rows: Array<{ id: string; config: unknown }> = [];
  for (const entry of await listSources(engine)) {
    const detail = await engine.getSource(entry.id);
    const config = typeof detail?.config === 'string' ? JSON.parse(detail.config) as Record<string, unknown> : detail?.config;
    if (config?.kind === 'apple-contacts') rows.push({ id: entry.id, config });
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  const row = wanted ? rows.find(r => r.id === wanted) : rows.length === 1 ? rows[0] : undefined;
  if (!row) {
    throw appleContactsError('apple_contacts_config', wanted ? 'There is no apple-contacts source named ' + wanted + '.' : rows.length ? 'There are ' + rows.length + ' apple-contacts sources; name one with --source.' : 'This brain has no apple-contacts source.',
      'gbrain sources list shows the sources; add one with gbrain sources add <id> --kind apple-contacts --helper-host <host> --token-file <path>.');
  }
  const config = typeof row.config === 'string' ? JSON.parse(row.config) as Record<string, unknown> : (row.config ?? {}) as Record<string, unknown>;
  return { id: row.id, cfg: parseAppleContactsSourceConfig(config) };
}

export function changeKey(op: string, parts: Array<string | undefined>): string {
  return 'own-' + createHash('sha256').update([op, ...parts.map(p => p ?? '')].join('\u0000')).digest('hex').slice(0, 40);
}

export async function runAppleContacts(engine: BrainEngine, args: string[]): Promise<void> {
  const asJson = args.includes('--json');
  const [sub, verb] = args;
  const norm = (value: string | null) => String(value ?? '').trim().toLowerCase();
  if (!sub || sub === '--help' || sub === '-h' || args.includes('--help')) { console.log(HELP); return; }
  if (sub === 'status') {
    const source = await resolveSource(engine, flag(args, '--source'));
    const state = { source: source.id, helper: source.cfg.helperHost + ':' + source.cfg.helperPort, write: norm(await engine.getConfig(WRITE_CONFIG_KEY).catch(() => null)) || 'off',
      destructive_writes: norm(await engine.getConfig(DESTRUCTIVE_CONFIG_KEY).catch(() => null)) || 'off',
      owner_key_file_set: !!norm(await engine.getConfig(OWNER_KEY_FILE_CONFIG_KEY).catch(() => null)) };
    console.log(asJson ? JSON.stringify(state) : Object.entries(state).map(([k, v]) => k + ': ' + v).join('\n'));
    return;
  }
  if (sub === 'enrich' && (verb === 'status' || verb === 'dry-run')) {
    const source = await resolveSource(engine, flag(args, '--source'));
    if (verb === 'dry-run') {
      const proposals = await proposeEnrichment(engine, source.id, parsePhoneCountryCode(await engine.getConfig(PHONE_COUNTRY_CODE_CONFIG_KEY).catch(() => null)));
      if (asJson) console.log(JSON.stringify({ dry_run: true, source: source.id, changes: proposals }));
      else console.log(proposals.length ? proposals.map(p => [p.change.op, p.change.id ?? 'new card', p.change.field ?? '', p.change.value ?? '', 'from ' + p.from.source_id + ':' + p.from.slug].filter(Boolean).join(' ')).join('\n')
        : 'Nothing to enrich.');
      return;
    }
    const record = await readEnrichRecord(engine, source.id);
    const mode = norm(await engine.getConfig(ENRICH_CONFIG_KEY).catch(() => null)) || 'off';
    if (asJson) { console.log(JSON.stringify({ source: source.id, enrich: mode, last_run: record })); return; }
    if (!record) { console.log('enrich: ' + mode + '\nNo enrichment run yet.'); return; }
    const counts = new Map<string, number>();
    for (const ch of record.changes) counts.set(ch.op + ' ' + ch.status, (counts.get(ch.op + ' ' + ch.status) ?? 0) + 1);
    console.log(['enrich: ' + mode, 'last run: ' + record.at + ' (' + record.mode + (record.sent ? ', sent' : ', nothing sent') + (record.note ? ': ' + record.note : '') + ')',
      ...[...counts].map(([k, n]) => '  ' + k + ': ' + n),
      ...record.changes.map(ch => '  ' + ch.op + ' ' + (ch.card ?? 'new card') + (ch.field ? ' ' + ch.field : '') + (ch.value ? ' = ' + ch.value : '') + ' from ' + ch.from + ': ' + ch.status + (ch.reason ? ' (' + ch.reason + ')' : ''))].join('\n'));
    return;
  }
  if (sub !== 'write' || !verb || !(verb in ADDITIVE || verb in DESTRUCTIVE)) {
    throw appleContactsError('apple_contacts_bad_request', 'Unknown apple-contacts command. Nothing was changed.', HELP);
  }
  const op = ADDITIVE[verb] ?? DESTRUCTIVE[verb]!;
  const mode = norm(await engine.getConfig(WRITE_CONFIG_KEY).catch(() => null)) || 'off';
  if (mode !== 'on' && mode !== 'dry_run') {
    throw appleContactsError('apple_contacts_write_off', 'Apple Contacts writes are off on this brain (' + WRITE_CONFIG_KEY + ' = ' + mode + '). Nothing was changed.',
      'The brain operator turns them on with: gbrain config set ' + WRITE_CONFIG_KEY + ' on');
  }
  if (verb in DESTRUCTIVE && norm(await engine.getConfig(DESTRUCTIVE_CONFIG_KEY).catch(() => null)) !== 'on') {
    throw appleContactsError('apple_contacts_destructive_off', 'Changing or removing what is on a card (' + verb + ') is off on this brain (' + DESTRUCTIVE_CONFIG_KEY + ' is not on). Nothing was changed.',
      'It stays off until the owner-sender guard is live on this host; then the operator runs: gbrain config set ' + DESTRUCTIVE_CONFIG_KEY + ' on');
  }
  const instruction = flag(args, '--owner-instruction')?.trim();
  if (!instruction || instruction.length > 1000) {
    throw appleContactsError('apple_contacts_bad_request', 'Every write carries the owner\'s own words as --owner-instruction (1 to 1000 characters). Nothing was changed.', HELP);
  }
  const card = flag(args, '--card'), from = flag(args, '--from'), field = flag(args, '--field'), value = flag(args, '--value');
  const group = flag(args, '--group'), label = flag(args, '--label');
  const fields = json(flag(args, '--fields-json'), '--fields-json');
  let expect = json(flag(args, '--expect-json'), '--expect-json');
  const need = (ok: boolean, what: string) => { if (!ok) throw appleContactsError('apple_contacts_bad_request', verb + ' needs ' + what + '. Nothing was changed.', HELP); };
  if (op === 'create') need(!!fields, '--fields-json'); else need(!!card, '--card <id>');
  if (['fill', 'set', 'add_value', 'remove_value'].includes(op)) need(!!field && !!value, '--field and --value');
  if (op === 'group_add' || op === 'group_remove') need(!!group, '--group <name>');
  if (op === 'merge') need(!!from, '--from <id>');
  if (op === 'delete') need(!!expect && Object.keys(expect).length > 0, '--expect-json with the card as the box last read it');
  if (op === 'set') { const old = flag(args, '--expect'); need(old !== undefined, '--expect <the value now>'); expect = { [field!]: old }; }
  const batch = 'own-' + Date.now().toString(36) + '-' + randomBytes(6).toString('hex');
  const change: ContactsWriteChange = {
    key: changeKey(op, [batch, card, from, field, value, group, fields ? JSON.stringify(fields) : undefined, expect ? JSON.stringify(expect) : undefined]), op,
    ...(card ? { id: card } : {}), ...(from ? { from } : {}), ...(field ? { field } : {}), ...(value !== undefined ? { value } : {}),
    ...(label ? { label } : {}), ...(group ? { group } : {}), ...(fields ? { fields } : {}), ...(expect ? { expect } : {}),
  };
  if (mode === 'dry_run') {
    console.log(JSON.stringify({ dry_run: true, batch, changes: [change] }));
    return;
  }
  const source = await resolveSource(engine, flag(args, '--source'));
  const key = readOwnerKey(String(await engine.getConfig(OWNER_KEY_FILE_CONFIG_KEY).catch(() => null) ?? '').trim());
  const countryCode = parsePhoneCountryCode(await engine.getConfig(PHONE_COUNTRY_CODE_CONFIG_KEY).catch(() => null));
  const reply = await sendContactsBatch({ sourceId: source.id, cfg: source.cfg, batch, countryCode, changes: [change],
    auth: { kind: 'owner', keyName: key.keyName, privateKey: key.privateKey, instruction } });
  const result = reply.results[0];
  if (asJson) console.log(JSON.stringify(reply));
  else console.log((result ? result.status + (result.reason ? ' (' + result.reason + ')' : '') + (result.id ? ': card ' + result.id : '') : 'no result') + '\nbatch ' + reply.batch + (reply.next ? '\n' + reply.next : ''));
  if (!result || !['applied', 'replayed'].includes(result.status)) setCliExitVerdict(1);
}
