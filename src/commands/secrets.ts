/**
 * `gbrain secrets` (GST-2988): the secret store from the trusted local CLI.
 *
 *   gbrain secrets list [--source <id>] [--slug <slug>] [--json]     entries and where they occur, never a value
 *   gbrain secrets reveal <id> [--json]                              the original behind <REDACTED:rule:id> (audited)
 *   gbrain secrets restore <id> [--apply --expect <hash>] [--json]   put a false positive back; preview first
 *   gbrain secrets key status [--json]                               which keys this host can read
 *   gbrain secrets key export [<key_id>] --out <file> --passphrase-stdin
 *   gbrain secrets key import <file> --passphrase-stdin
 *   gbrain secrets backup [--restore <object>] [--json]             encrypted export to the configured storage backend
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { BrainEngine } from '../core/engine.ts';
import { opError } from '../core/ops/contract.ts';
import { readStdinBounded } from '../core/interaction.ts';
import { exportKeyEscrow, importKeyEscrow, keyringStatus, markEscrowExported, type KeyEscrow } from '../core/secret-store/keyring.ts';
import { countsByRule, keysInUse, listEntries, reveal } from '../core/secret-store/store.ts';
import { applyRestore, previewRestore } from '../core/secret-store/restore.ts';

const HELP = `Usage: gbrain secrets <command>

The secret store keeps the originals that redaction replaced with <REDACTED:rule:ss_...> markers,
encrypted with a key kept on this machine (never in the database or a backup).

  list [--source <id>] [--slug <slug>] [--json]       Entries and the pages that hold their markers (no values)
  reveal <id> [--json]                                Print one original (audited)
  restore <id> [--json]                               Preview putting a false positive back
  restore <id> --apply --expect <hash> [--json]       Put it back; later redactions leave it alone
  key status [--json]                                 Keys this host can read, and keys entries need
  key export [<key_id>] --out <file> --passphrase-stdin   Passphrase-wrapped copy of a key, to keep elsewhere
  key import <file> --passphrase-stdin                Add an exported key to this host's keyring
  backup [--json]                                     Upload an encrypted export to the configured storage backend
  backup --restore <object> [--json]                  Add the entries of one backup that this brain lacks
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) throw opError('invalid_params', `${name} requires a value.`, HELP.split('\n')[0]!);
  return value;
}

async function passphrase(args: string[]): Promise<string> {
  if (!args.includes('--passphrase-stdin')) throw opError('invalid_params', 'Pass the escrow passphrase on stdin with --passphrase-stdin.', 'Example: printf %s "$PASS" | gbrain secrets key export --out key.json --passphrase-stdin');
  const read = await readStdinBounded({ maxBytes: 4096 });
  if (read.kind !== 'data') throw opError('invalid_params', 'No passphrase arrived on stdin.', 'Pipe the passphrase into the command.');
  return read.text.replace(/\r?\n$/, '');
}

const print = (json: boolean, value: unknown, text: string) => console.log(json ? JSON.stringify(value, null, 2) : text);

export async function runSecrets(engine: BrainEngine, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const json = rest.includes('--json');
  if (!sub || sub === '--help' || sub === '-h' || rest.includes('--help')) { console.log(HELP); return; }
  if (sub === 'list') {
    const entries = await listEntries(engine, { sourceId: flag(rest, '--source'), slug: flag(rest, '--slug') });
    const spooled = (await import('../core/secret-store/spool.ts')).undrainedCount();
    const spoolLine = spooled ? [`${spooled} original(s) a publish redacted wait in this machine's spool for the store; maintenance or the next push moves them (gbrain secrets reveal reads them meanwhile).`] : [];
    const by_rule = await countsByRule(engine, flag(rest, '--source'));
    const publish_redactions = await (await import('../core/git/redact-finish.ts')).publishRedactionCounts(engine, flag(rest, '--source'));
    const ruleLines = [
      ...Object.entries(by_rule).map(([rule, c]) => `${rule}: ${c.entries} entr${c.entries === 1 ? 'y' : 'ies'}, ${c.occurrences} occurrence(s)`),
      ...Object.entries(publish_redactions.rules).map(([rule, c]) => `publish redactions on this machine, ${rule}: ${c.hits} hit(s) of ${c.values} value(s), ${c.signed_link} in a signed-link credential parameter (X-Amz-Credential=), ${c.bare} bare`),
    ];
    print(json, { entries, spooled, by_rule, publish_redactions }, [...(entries.length
      ? entries.map(e => `${e.id}  ${e.rule}  ${e.status}  ${e.source_id}  ${e.occurrences} occurrence(s)  ${e.slugs.join(', ') || '-'}${e.readable ? '' : '  (key ' + e.key_id + ' not on this host)'}`)
      : ['No secret store entries.']), ...ruleLines, ...spoolLine].join('\n'));
    return;
  }
  if (sub === 'reveal') {
    const id = rest.find(a => !a.startsWith('--'));
    if (!id) throw opError('invalid_params', 'gbrain secrets reveal needs an entry id.', 'gbrain secrets list shows the ids.');
    const out = await reveal(engine, id, 'local-cli');
    print(json, out, out.value);
    return;
  }
  if (sub === 'restore') {
    const id = rest.find(a => !a.startsWith('--') && a !== flag(rest, '--expect'));
    if (!id) throw opError('invalid_params', 'gbrain secrets restore needs an entry id.', 'gbrain secrets list shows the ids.');
    if (!rest.includes('--apply')) {
      const preview = await previewRestore(engine, id);
      print(json, preview, [`Restore ${preview.id} (${preview.rule}) in ${preview.pages.length} page(s):`,
        ...preview.pages.map(p => `  ${preview.source_id}:${p.slug}  ${p.fields.join(', ')}`),
        `Apply: ${preview.command} --apply --expect ${preview.hash}`].join('\n'));
      return;
    }
    const expect = flag(rest, '--expect');
    if (!expect) throw opError('invalid_params', 'gbrain secrets restore --apply restores only the set a preview printed.', `Preview first: gbrain secrets restore ${id}`);
    const out = await applyRestore(engine, id, expect, 'local-cli');
    print(json, out, `Restored ${out.id} in ${out.restored.length} page(s); later redactions leave this value alone.`);
    return;
  }
  if (sub === 'key') {
    const [action, ...more] = rest;
    if (action === 'status') {
      const status = keyringStatus();
      const inUse = await keysInUse(engine);
      const readable = new Set(status.keys.filter(k => k.readable).map(k => k.id));
      if (status.origin === 'env' && status.current) readable.add(status.current);
      const missing = inUse.filter(k => !readable.has(k.key_id));
      print(json, { ...status, in_use: inUse, missing }, [
        `Key source: ${status.origin}${status.current ? `, current ${status.current}` : ''} (${status.dir})`,
        ...status.keys.map(k => `  ${k.id}  ${k.readable ? 'readable' : 'unreadable'}${k.mode_ok ? '' : ', readable by others (not used)'}`),
        ...(missing.length ? [`Entries need keys this host does not have: ${missing.map(k => `${k.key_id} (${k.entries}, sealed on ${k.key_host || 'unknown host'})`).join(', ')}`] : []),
      ].join('\n'));
      return;
    }
    if (action === 'export') {
      const out = flag(more, '--out');
      if (!out) throw opError('invalid_params', 'gbrain secrets key export needs --out <file>.', 'Name a file outside the brain repository.');
      const id = more.find(a => !a.startsWith('--') && a !== out) ?? keyringStatus().current;
      if (!id) throw opError('secret_store_key_missing', 'This host has no secret store key yet, so there is nothing to export.', 'A key is made on the first redaction.');
      writeFileSync(out, JSON.stringify(exportKeyEscrow(id, await passphrase(more)), null, 2) + '\n', { mode: 0o600 });
      markEscrowExported(id);
      print(json, { exported: id, file: out }, `Exported key ${id} to ${out}. Keep it, and its passphrase, somewhere other than this machine and the brain's backups.`);
      return;
    }
    if (action === 'import') {
      const file = more.find(a => !a.startsWith('--'));
      if (!file) throw opError('invalid_params', 'gbrain secrets key import needs the file key export wrote.', 'gbrain secrets key import <file> --passphrase-stdin');
      const id = importKeyEscrow(JSON.parse(readFileSync(file, 'utf8')) as KeyEscrow, await passphrase(more));
      print(json, { imported: id }, `Imported key ${id}.`);
      return;
    }
  }
  if (sub === 'backup') {
    const { backupStore, configuredStorage, restoreBackup, SKIPPED_NO_PAGE_NEXT, SKIPPED_NO_PAGE_TEXT } = await import('../core/secret-store/backup.ts');
    const configured = await configuredStorage();
    if (!configured) {
      print(json, { backend: null, carried_by: 'database_backup' }, 'No storage backend is configured, so nothing was uploaded: the brain\'s database backup carries the secret store.');
      return;
    }
    const object = flag(rest, '--restore');
    if (object) {
      const out = await restoreBackup(engine, configured.storage, object);
      print(json, out, [`Restored ${out.inserted} entr${out.inserted === 1 ? 'y' : 'ies'} (${out.occurrences} occurrence(s)) from ${out.object}; ${out.existing} already here and left as they are.`,
        ...(out.skipped_no_page ? [`${out.skipped_no_page} ${SKIPPED_NO_PAGE_TEXT}. ${SKIPPED_NO_PAGE_NEXT}`] : []),
        ...(out.unreadable.length ? [`Skipped ${out.unreadable.length} that do not authenticate under a key on this host: ${out.unreadable.join(', ')}`] : [])].join('\n'));
      return;
    }
    const out = await backupStore(engine, configured.storage, configured.identity);
    print(json, out, `Uploaded ${out.object}: ${out.entries} entr${out.entries === 1 ? 'y' : 'ies'}, ${out.occurrences} occurrence(s), sealed with key ${out.key_id}. It restores only where that key is.`);
    return;
  }
  throw opError('invalid_params', `Unknown gbrain secrets command: ${args.join(' ')}`, 'Use gbrain secrets list, gbrain secrets reveal ss_ID, gbrain secrets restore, gbrain secrets key status|export|import, or gbrain secrets backup.');
}
