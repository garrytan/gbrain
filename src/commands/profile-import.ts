/**
 * `gbrain profile import` (lane 3 P2): preview another assistant's memory export as profile facts, apply exactly that
 * preview, and show or resume its progress receipt. Parsing runs here, on the client; the facts are saved through the
 * caller's own remember batches, so they land on the caller's own profile and nowhere else.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { IMPORT_FORMATS, planImport, previewHash, type ImportFormat, type ImportTarget } from '../core/profile/import.ts';
import { newReceipt, runImport, summarize, type ImportCall, type ImportReceipt } from '../core/profile/import-run.ts';
import { setCliExitVerdict, writeJsonDocument } from '../core/cli-force-exit.ts';
import { shellQuote } from '../core/agent-output.ts';

export const IMPORT_HELP = `Usage:
  gbrain profile import <file> [--format auto|${IMPORT_FORMATS.join('|')}] [--source <id>] [--json]   preview
  gbrain profile import <file> --yes --preview <hash> [--format ...] [--json]        apply that preview
  gbrain profile import --status <receipt> [--json]                                  show a receipt
  gbrain profile import --resume <receipt> [--json]                                  finish an interrupted apply

Imports another assistant's memories onto your own profile: Muse's Memory.md (muse-memory), the memories JSON in a
Claude data export (claude-memories), or the "[YYYY-MM-DD] - memory" list any assistant prints for Claude's import
prompt (memory-text). Every fact is saved private and inferred; credential-shaped lines are dropped and named by line.
The preview prints a hash; the apply refuses unless the file, the parse and your profile still match it.

Guide: docs/guides/profile.md#import`;

export interface ImportFlags { file?: string; format: ImportFormat | 'auto'; yes: boolean; preview?: string; status?: string; resume?: string; source?: string; json: boolean }

export function parseImportArgs(args: string[]): ImportFlags | { error: string } {
  const f: ImportFlags = { format: 'auto', yes: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value = () => { const v = args[++i]; if (v === undefined || v.startsWith('--')) throw new Error(`${a} takes a value.`); return v; };
    try {
      if (a === '--json') f.json = true;
      else if (a === '--yes') f.yes = true;
      else if (a === '--preview') f.preview = value();
      else if (a === '--status') f.status = value();
      else if (a === '--resume') f.resume = value();
      else if (a === '--source') f.source = value();
      else if (a === '--format') {
        const v = value();
        if (v !== 'auto' && !(IMPORT_FORMATS as readonly string[]).includes(v)) return { error: `--format takes auto, ${IMPORT_FORMATS.join(', ')}; got ${JSON.stringify(v)}.` };
        f.format = v as ImportFlags['format'];
      } else if (!a.startsWith('-') && f.file === undefined) f.file = a;
      else return { error: `Unknown argument ${JSON.stringify(a)}.` };
    } catch (e) { return { error: (e as Error).message }; }
  }
  const modes = [f.status, f.resume, f.file].filter(x => x !== undefined).length;
  if (modes !== 1) return { error: 'Pass one of: a file to preview or apply, --status <receipt>, or --resume <receipt>.' };
  if (f.yes !== (f.preview !== undefined)) return { error: 'Apply needs both --yes and --preview <hash> from the preview.' };
  return f;
}

export function loadReceipt(path: string): ImportReceipt {
  const r = JSON.parse(readFileSync(path, 'utf8')) as ImportReceipt;
  if (r?.schema !== 1 || typeof r.preview !== 'string' || !Array.isArray(r.batches)) throw new Error(`${path} is not a profile import receipt.`);
  return r;
}

/** Writes the receipt whole or not at all (a temporary file renamed over it), readable only by the owner. */
export function saveReceipt(path: string, r: ImportReceipt): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(r, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export const receiptPath = (dir: string, hash: string) => join(dir, 'profile-imports', `${hash}.json`);

async function report(r: ImportReceipt, path: string, json: boolean, global: string[], scope: string[]): Promise<void> {
  const s = summarize(r);
  const resume = ['gbrain', ...global, 'profile', 'import', '--resume', path, ...scope];
  if (json) {
    await writeJsonDocument(JSON.stringify({ receipt: path, preview: r.preview, profile: r.target.profile, ...s,
      ...(r.batches.some(b => b.state === 'failed') ? { batch_errors: r.batches.filter(b => b.error).map(b => ({ batch: b.index, ...b.error })) } : {}),
      ...(s.complete ? {} : { resume_argv: resume }) }, null, 2));
    return;
  }
  console.log(`Receipt ${path} (preview ${r.preview}, profile ${r.target.profile})`);
  console.log(`Batches: ${Object.entries(s.batches).map(([k, n]) => `${n} ${k}`).join(', ')}; items: ${Object.entries(s.items).map(([k, n]) => `${n} ${k}`).join(', ') || 'none sent'}.`);
  for (const f of s.failed) console.log(`  failed: line ${f.line} ${f.error?.code ?? ''} ${f.error?.message ?? ''}`.trimEnd());
  for (const b of r.batches.filter(b => b.state === 'failed')) console.log(`  batch ${b.index} refused: ${b.error?.code} ${b.error?.message}`);
  if (s.failed.length) console.log('Failed lines are not retried: fix them in the file, then preview and apply again (saved lines come back as duplicates, not new facts).');
  if (!s.complete) console.log(`Finish it with: ${shellQuote(resume)}`);
}

/**
 * Runs the import subcommand with `call` reaching the brain and `target` naming the caller and its profile; `global` are the
 * global flags (`--brain <id>`) the printed apply and resume commands repeat, with the `--source` the import was given.
 */
export async function runProfileImport(args: string[], call: ImportCall, target: () => Promise<ImportTarget>, homeDir: string, global: string[] = []): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(IMPORT_HELP); return; }
  const { opError } = await import('../core/ops/contract.ts');
  const f = parseImportArgs(args);
  if ('error' in f) throw opError('invalid_params', f.error, 'gbrain profile import --help lists the forms.');
  const scope = f.source ? ['--source', f.source] : [];
  if (f.status) { await report(loadReceipt(f.status), f.status, f.json, global, scope); return; }
  const prior = f.resume ? loadReceipt(f.resume) : null;
  const file = prior ? prior.file : resolve(f.file!);
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (e) {
    throw opError('invalid_params', `profile import: cannot read ${file} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); nothing was sent.`, 'Pass the path of the exported memory file.');
  }
  const plan = planImport(text, prior ? prior.format : f.format);
  const who = await target();
  const hash = previewHash(plan, who);
  if (prior && (hash !== prior.preview || who.principal !== prior.target.principal || who.profile !== prior.target.profile)) {
    throw opError('preview_changed', `The receipt was written for preview ${prior.preview}, but the file, its parse or the caller's profile changed (now ${hash}); nothing was sent.`,
      'Preview the file again and apply the new preview; batches already saved come back as duplicates.');
  }
  if (!prior && !f.yes) {
    const byFacet: Record<string, number> = {};
    for (const i of plan.items) byFacet[i.facet] = (byFacet[i.facet] ?? 0) + 1;
    const apply = ['gbrain', ...global, 'profile', 'import', file, '--format', plan.format, '--yes', '--preview', hash, ...scope];
    if (f.json) { await writeJsonDocument(JSON.stringify({ preview: hash, format: plan.format, profile: who.profile, items: plan.items.length, by_facet: byFacet, facts: plan.items, dropped: plan.dropped, apply_argv: apply }, null, 2)); return; }
    console.log(`Preview ${hash}: ${plan.items.length} fact(s) from ${basename(file)} (${plan.format}) onto ${who.profile}, saved private and inferred.`);
    for (const i of plan.items) console.log(`  line ${i.line} [${i.facet}] ${i.fact.length > 100 ? i.fact.slice(0, 99) + '…' : i.fact}`);
    for (const d of plan.dropped) console.log(`  dropped line ${d.line}: ${d.reason}`);
    console.log(`Apply: ${shellQuote(apply)}`);
    return;
  }
  if (!prior && f.preview !== hash) {
    throw opError('preview_changed', `--preview ${f.preview} does not match this file, its parse and your profile (now ${hash}); nothing was sent.`,
      'Preview the file again and apply the hash it prints.');
  }
  const path = f.resume ?? receiptPath(homeDir, hash);
  let receipt: ImportReceipt;
  try { receipt = loadReceipt(path); } catch { receipt = newReceipt(plan, hash, file, who, `imported from ${basename(file)} (${plan.format}), preview ${hash}`); }
  saveReceipt(path, receipt);
  await runImport(plan, receipt, call, r => saveReceipt(path, r));
  await report(receipt, path, f.json, global, scope);
  const s = summarize(receipt);
  if (receipt.batches.some(b => b.state === 'pending')) setCliExitVerdict(10);
  else if (!s.complete || s.failed.length) setCliExitVerdict(1);
}
