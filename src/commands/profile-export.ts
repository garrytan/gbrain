/**
 * `gbrain profile export` (lane 3 P3): your own profile as text another assistant keeps. It reads the profile through
 * context_pack {profile: true} (in process locally, over MCP on a thin client) and writes nothing to the brain. Only
 * world-visible facts leave by default; --include-private adds private ones with a warning, because the exported text
 * is outside gbrain's access control.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fchmodSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { EXPORT_FORMATS, mergeMuseBlock, renderMarkdown, renderMemoryText, renderMuseBlock, selectFacts, type ExportFormat } from '../core/profile/export.ts';
import { PROFILE_CLAIM_CAP, type ProfileBlock } from '../core/profile/read.ts';
import type { ImportCall } from '../core/profile/import-run.ts';
import { opError } from '../core/ops/contract.ts';
import { writeJsonDocument } from '../core/cli-force-exit.ts';

export const EXPORT_HELP = `Usage:
  gbrain profile export --format ${EXPORT_FORMATS.join('|')} [--include-private] [--json]   print it
  gbrain profile export --format muse-memory --into <Memory.md> [--include-private] [--json] update Muse's memory file

Exports your own profile for another assistant: the "[YYYY-MM-DD] - memory" list Claude's memory import reads
(memory-text), a marked GBrain block for Muse's Memory.md (muse-memory) or a readable page (markdown). Only facts visible
to everyone are exported; --include-private adds your private ones (allergies are private by default), and the text
then sits outside gbrain's access control. --into replaces the previous GBrain block in the file and leaves your own
lines alone; a file with a damaged block is refused and left untouched. Nothing is written to the brain.

Guide: docs/guides/profile.md#export`;

export interface ExportFlags { format?: ExportFormat; includePrivate: boolean; into?: string; json: boolean }

export function parseExportArgs(args: string[]): ExportFlags | { error: string } {
  const f: ExportFlags = { includePrivate: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') f.json = true;
    else if (a === '--include-private') f.includePrivate = true;
    else if (a === '--format' || a === '--into') {
      const v = args[++i];
      if (v === undefined || v.startsWith('--')) return { error: `${a} takes a value.` };
      if (a === '--into') f.into = v;
      else if ((EXPORT_FORMATS as readonly string[]).includes(v)) f.format = v as ExportFormat;
      else return { error: `--format takes ${EXPORT_FORMATS.join(', ')}; got ${JSON.stringify(v)}.` };
    } else return { error: `Unknown argument ${JSON.stringify(a)}.` };
  }
  if (!f.format) return { error: `Pass --format ${EXPORT_FORMATS.join('|')}.` };
  if (f.into !== undefined && f.format !== 'muse-memory') return { error: '--into updates a Muse memory file; it works only with --format muse-memory.' };
  return f;
}

/**
 * Writes the file whole or not at all: a temporary file only this call creates (random name, exclusive, 0600) is renamed
 * over it, keeping an existing file's mode (owner-only when it holds private facts). Refuses, writing nothing, when the
 * file changed after it was read.
 */
function writeWhole(path: string, text: string, before: string, ownerOnly: boolean): void {
  const mode = ownerOnly ? 0o600 : existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    try { writeFileSync(fd, text); fchmodSync(fd, mode); } finally { closeSync(fd); }
    if ((existsSync(path) ? readFileSync(path, 'utf8') : '') !== before) {
      throw opError('invalid_params', `profile export: ${path} changed while the export was writing it; it was left as it is.`, 'Export again.');
    }
    renameSync(tmp, path);
  } catch (e) { rmSync(tmp, { force: true }); throw e; }
}

/** The file a path names, following symlinks to their target even when that target does not exist yet. */
function destination(path: string): string {
  let at = resolve(path);
  try {
    for (let hop = 0; hop < 40; hop++) {
      if (existsSync(at)) return realpathSync(at);
      if (!lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) return at;
      const parent = dirname(at);
      at = resolve(existsSync(parent) ? realpathSync(parent) : parent, readlinkSync(at));
    }
  } catch (e) {
    throw opError('invalid_params', `profile export: cannot resolve ${path} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); nothing was written.`, 'Pass the path of your Memory.md.');
  }
  throw opError('invalid_params', `profile export: ${path} is a symlink loop; nothing was written.`, 'Pass the path of your Memory.md.');
}

export async function runProfileExport(args: string[], call: ImportCall): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(EXPORT_HELP); return; }
  const f = parseExportArgs(args);
  if ('error' in f) throw opError('invalid_params', f.error, 'gbrain profile export --help lists the forms.');
  const block = (await call('context_pack', { profile: true })).profile as ProfileBlock | undefined;
  if (!block) throw opError('unavailable', 'The brain did not return a profile: it may predate context_pack {profile: true}; nothing was exported.', 'Upgrade the brain with gbrain upgrade.');
  if (!block.entity) throw opError('profile_entity_not_self', 'profile export: this credential has no profile (it speaks for no member and is not the brain owner); nothing was exported.',
    'Export from the brain owner\'s CLI or a member credential.');
  const { facts, private_left_out } = selectFacts(block, f.includePrivate);
  const privateIncluded = facts.filter(x => x.visibility === 'private').length;
  const withheld = block.withheld ?? 0;
  const cut = facts.filter(x => x.claim.length >= PROFILE_CLAIM_CAP).length;
  const text = f.format === 'memory-text' ? renderMemoryText(facts) : f.format === 'markdown' ? renderMarkdown(block, facts) : renderMuseBlock(facts);
  const into = f.into === undefined ? undefined : destination(f.into);
  if (into && block.partial) {
    throw opError('unavailable', `profile export: the brain returned an incomplete profile (too many facts on your page, or a failed read), so ${into} was left as it is rather than replace its GBrain block with part of your profile.`,
      'Export again later, or print the export without --into and copy what you need.');
  }
  if (into) {
    let existing = '';
    if (existsSync(into)) {
      try { existing = readFileSync(into, 'utf8'); } catch (e) {
        throw opError('invalid_params', `profile export: cannot read ${into} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); nothing was written.`, 'Pass the path of your Memory.md.');
      }
    }
    writeWhole(into, mergeMuseBlock(existing, text), existing, privateIncluded > 0);
  }
  if (privateIncluded) console.error(`Warning: ${privateIncluded} private fact(s) included. This text is outside gbrain's access control: anyone or any assistant that reads it reads them.`);
  else if (private_left_out) console.error(`${private_left_out} private fact(s) left out; --include-private adds them.`);
  if (withheld) console.error(`Warning: ${withheld} fact(s) this credential cannot read were not exported, even with --include-private; export from the brain owner's CLI or a credential bound to you to include them.`);
  if (cut) console.error(`Warning: ${cut} fact(s) longer than ${PROFILE_CLAIM_CAP} characters were cut at ${PROFILE_CLAIM_CAP}; gbrain profile shows the same text.`);
  if (block.partial) console.error('Warning: the profile may be incomplete (too many facts on your page, or a failed read); the export may miss facts.');
  if (f.json) {
    await writeJsonDocument(JSON.stringify({ format: f.format, profile: block.entity.slug, exported: facts.length, private_included: privateIncluded,
      private_left_out: f.includePrivate ? 0 : private_left_out, ...(withheld ? { withheld } : {}), ...(cut ? { cut } : {}), ...(block.partial ? { partial: true } : {}),
      ...(into ? { into } : { text }) }, null, 2));
    return;
  }
  if (into) console.log(`Wrote ${facts.length} fact(s) into the GBrain block of ${into}.`);
  else process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}
