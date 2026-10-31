/**
 * `gbrain skillpack reference <name>|--all --update-untouched`, `skillpack pin|unpin`
 * and `skillpack restore` — the safe-update lane (core: src/core/skillpack/safe-update.ts).
 *
 * Never prompts: `--dry-run` is the preview. Exit 0 when nothing failed
 * (skips are in the summary and JSON), 1 only with --fail-on-skipped when
 * something was skipped, 2 on a failure (files touched and the restore
 * command are printed). Flag-registry note: this file is scanned for
 * skillpack's flag allowlist — spell foreign CLI flags without dashes here.
 */
import { join } from 'path';

import { BundleError, bundledSkillSlugs, loadBundleManifest } from '../../core/skillpack/bundle.ts';
import { acquireFileLock, workspaceLockPath, type FileLock } from '../../core/skillpack/file-lock.ts';
import {
  runSkillpackRestore, runSkillpackUpdate, setSkillPinned, skillsRootKey, type UpdateResult,
} from '../../core/skillpack/safe-update.ts';
import { listJournals, readJournal } from '../../core/skillpack/update-journal.ts';
import { exitCliError } from '../../cli/cli-error.ts';
import { findGbrainOrDie, resolveWorkspace } from './shared.ts';

export const UPDATE_HELP =
  'gbrain skillpack reference <name>|--all --update-untouched [--workspace PATH] [--dry-run] [--json]\n' +
  '    [--no-diff] [--accept-historical] [--fail-on-skipped]\n\n' +
  'Take gbrain\'s current version of installed skills you never edited, one whole\n' +
  'skill at a time. A skill updates only when every file still matches the hash\n' +
  'recorded at install (or, with --accept-historical, a released version when\n' +
  'no hash was recorded) and the skill is not pinned. Anything else\n' +
  'is skipped with a reason and a diff. Never prompts; --dry-run is the preview.\n' +
  'Every update is journaled under ~/.gbrain/skillpack-backups/<id>/ and can be\n' +
  'undone with gbrain skillpack restore <id>.\n\n' +
  'Exit: 0 nothing failed; 1 with --fail-on-skipped when a skill was skipped;\n' +
  '2 a skill failed and was rolled back (files touched and restore command printed).';

function workspaceSkillsRoot(workspace: string | null): string {
  return skillsRootKey(join(resolveWorkspace({ workspace }), 'skills'));
}

function readValue(args: string[], flag: string): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) return args[i + 1] ?? null;
    if (args[i]?.startsWith(`${flag}=`)) return args[i]!.slice(flag.length + 1) || null;
  }
  return null;
}

function positionals(args: string[], valueFlags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valueFlags.includes(a)) i++;
    else if (!a.startsWith('-')) out.push(a);
  }
  return out;
}

function printUpdate(result: UpdateResult): void {
  const verb = result.dry_run ? 'skillpack update-untouched (dry run)' : 'skillpack update-untouched';
  console.log(`${verb}: ${result.skills_root}`);
  if (!result.history.verified) console.log(`  history UNVERIFIED (${result.history.reason}): whole-file updates are disabled (history_unverified)`);
  for (const id of result.pending_journals) console.log(`  an earlier update did not finish: gbrain skillpack restore ${id}`);
  for (const s of result.skills) {
    if (s.result === 'current' || s.result === 'not_installed') continue;
    const detail = s.result === 'skipped' ? s.reason : s.result === 'failed' ? s.failure : `${s.changes.length} file(s)`;
    console.log(`  ${s.result.padEnd(13)} ${s.slug.padEnd(32)} ${detail}`);
    for (const note of s.notes) console.log(`                note: ${note}`);
  }
  const c = result.summary;
  console.log(`updated: ${c.updated}  would update: ${c.would_update}  skipped: ${c.skipped}  failed: ${c.failed}  current: ${c.current}  not installed: ${c.not_installed}`);
  const historical = result.skills.filter(s => s.historical.length > 0);
  if (historical.length) {
    console.log('\nMatch only a released version (no recorded base; take them with --accept-historical):');
    for (const s of historical) console.log(`  ${s.slug}: ${s.historical.join(', ')}`);
  }
  const diffs = result.skills.filter(s => s.diffs?.length);
  if (diffs.length) {
    console.log('\nSkipped skills, your copy (a/) against gbrain\'s (b/); first 200 lines per file, secret-looking values redacted.');
    console.log('Merge by hand what you want; gbrain skillpack reference <name> shows the full diff.');
    for (const s of diffs) for (const d of s.diffs!) console.log(`\n${d.diff}`);
  }
  const failed = result.skills.filter(s => s.result === 'failed');
  if (failed.length) {
    console.log('\nFailed (rolled back):');
    for (const s of failed) {
      console.log(`  ${s.slug}: ${s.failure}`);
      if (s.touched?.length) console.log(`    files touched: ${s.touched.join(', ')}`);
      if (s.rollback_skipped?.length) console.log(`    left as changed since the update: ${s.rollback_skipped.join(', ')}`);
    }
    console.log(`Undo everything this run applied: ${result.restore_command}`);
  }
}

export async function cmdUpdateUntouched(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(UPDATE_HELP);
    process.exit(0);
  }
  for (const bad of ['--apply-clean-hunks', '--since', '--harness']) {
    if (args.some(a => a === bad || a.startsWith(`${bad}=`))) {
      console.error(`Error: --update-untouched does not combine with ${bad}. Run gbrain skillpack reference --help for the read-only lens.`);
      process.exit(2);
    }
  }
  const all = args.includes('--all');
  const names = positionals(args, ['--workspace']);
  if (all === names.length > 0) {
    console.error('Error: pass one skill name or --all.');
    process.exit(2);
  }
  const json = args.includes('--json');
  const gbrainRoot = findGbrainOrDie();
  const skillsRoot = workspaceSkillsRoot(readValue(args, '--workspace'));
  let lock: FileLock | null = null;
  let result: UpdateResult;
  try {
    lock = await acquireFileLock(workspaceLockPath(skillsRoot), { code: 'skillpack_workspace_locked' });
    result = await runSkillpackUpdate({
      gbrainRoot, skillsRoot, slugs: all ? null : names,
      dryRun: args.includes('--dry-run'), acceptHistorical: args.includes('--accept-historical'), noDiff: args.includes('--no-diff'),
    });
  } catch (err) {
    lock?.release();
    if (err instanceof BundleError) {
      console.error(`skillpack reference --update-untouched: ${err.message}`);
      process.exit(2);
    }
    exitCliError(err, 'skillpack');
  }
  lock!.release();
  if (json) console.log(JSON.stringify({ ...result!, skills: result!.skills.map(({ files: _files, ...s }) => s) }, null, 2));
  else printUpdate(result!);
  if (result!.summary.failed > 0) process.exit(2);
  process.exit(args.includes('--fail-on-skipped') && result!.summary.skipped > 0 ? 1 : 0);
}

export async function cmdPin(args: string[], pinned: boolean): Promise<void> {
  const sub = pinned ? 'pin' : 'unpin';
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`gbrain skillpack ${sub} <skill> [--workspace PATH] [--json]\n\n` +
      (pinned ? 'Pin an installed skill: --update-untouched never updates it.' : 'Unpin a skill so --update-untouched may update it again.'));
    process.exit(0);
  }
  const [slug, extra] = positionals(args, ['--workspace']);
  if (!slug || extra) {
    console.error(`Error: gbrain skillpack ${sub} takes exactly one skill name.`);
    process.exit(2);
  }
  const gbrainRoot = findGbrainOrDie();
  if (!bundledSkillSlugs(loadBundleManifest(gbrainRoot)).includes(slug)) {
    console.error(`Error: '${slug}' is not a bundled skill (gbrain skillpack list shows them).`);
    process.exit(2);
  }
  const skillsRoot = workspaceSkillsRoot(readValue(args, '--workspace'));
  let changed: boolean;
  try {
    changed = await setSkillPinned(skillsRoot, slug, pinned);
  } catch (err) {
    exitCliError(err, 'skillpack');
  }
  if (args.includes('--json')) console.log(JSON.stringify({ ok: true, skill: slug, skills_root: skillsRoot, pinned, changed: changed! }, null, 2));
  else console.log(`${slug} ${changed! ? (pinned ? 'pinned' : 'unpinned') : (pinned ? 'was already pinned' : 'was not pinned')} under ${skillsRoot}`);
  process.exit(0);
}

export async function cmdRestore(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('gbrain skillpack restore <id> [--skip <file>]... [--json]\ngbrain skillpack restore --list [--json]\n\n' +
      'Undo a --update-untouched run: put back each file it replaced, and remove each file it\n' +
      'added, when the file still holds the update\'s bytes. A file you changed since the update\n' +
      'refuses the whole restore unless you name it with --skip <file> (path under the skills\n' +
      'root). Running it again is a no-op. Backups are kept 30 days or the newest 10.');
    process.exit(0);
  }
  const json = args.includes('--json');
  if (args.includes('--list')) {
    const journals = listJournals().map(j => ({
      id: j.id, status: j.status, skills_root: j.skills_root, created_at: j.created_at,
      skills: j.skills.map(s => ({ slug: s.slug, status: s.status, files: s.files.length })),
    }));
    if (json) console.log(JSON.stringify({ journals }, null, 2));
    else if (!journals.length) console.log('No skillpack update backups.');
    else for (const j of journals) console.log(`${j.id}  ${j.status.padEnd(8)}  ${j.skills.map(s => `${s.slug}:${s.status}`).join(', ')}  (${j.skills_root})`);
    process.exit(0);
  }
  const skip: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--skip' && args[i + 1]) skip.push(args[++i]!);
  const [id, extra] = positionals(args, ['--skip']);
  if (!id || extra) {
    console.error('Error: gbrain skillpack restore takes one backup id (gbrain skillpack restore --list).');
    process.exit(2);
  }
  let lock: FileLock | null = null;
  try {
    const journal = readJournal(id);
    lock = await acquireFileLock(workspaceLockPath(journal.skills_root), { code: 'skillpack_workspace_locked' });
    const result = await runSkillpackRestore({ id, skip });
    if (json) console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    else {
      console.log(`skillpack restore ${id}: ${result.skills_root}`);
      for (const f of result.files) console.log(`  ${f.action.padEnd(16)} ${f.rel}`);
    }
  } catch (err) {
    lock?.release();
    exitCliError(err, 'skillpack');
  }
  lock!.release();
  process.exit(0);
}
