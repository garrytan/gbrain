/**
 * self_capture doctor check (#5413): corpus files captured from gbrain's own
 * claude-cli sessions before the session-end hook refused them. Dream
 * discovery and the sweep already skip every self-capture they can identify;
 * this check counts what is still sitting in the session corpus so the
 * operator can quarantine it by hand. It never moves or deletes anything.
 *
 * Classified: the file's session id matches a harness transcript under a
 * gbrain claude-cli scratch project. Unclassifiable: no harness transcript
 * exists for the session any more (Claude Code pruned it), so whether it is
 * a self-capture cannot be decided from this host. Best-effort: both counts
 * read the local filesystem of the brain host.
 */
import { readdirSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { claudeCliSelfSessionIds } from '../../../core/ai/providers/claude-cli-scratch.ts';
import { claudeProjectsDir } from '../../../core/bootstrap/host-specs.ts';
import { corpusFileSessionId } from '../../../core/context/corpus-segments.ts';
import { pruneDir } from '../../../core/sync.ts';

const SAMPLE = 20;
const CORPUS_KEY = 'dream.synthesize.session_corpus_dir';

function harnessSessionIds(projectsRoot: string): Set<string> {
  const ids = new Set<string>();
  let projects: string[];
  try { projects = readdirSync(projectsRoot); } catch { return ids; }
  for (const project of projects) {
    let files: string[];
    try { files = readdirSync(join(projectsRoot, project)); } catch { continue; }
    for (const file of files) if (file.endsWith('.jsonl')) ids.add(file.slice(0, -'.jsonl'.length));
  }
  return ids;
}

/** Every `.txt` under the corpus (dream discovery's pruning), and whether any directory could not be read. */
function corpusTextFiles(root: string): { files: string[]; unreadable: number } {
  const files: string[] = [];
  let unreadable = 0;
  const walk = (dir: string, top: boolean) => {
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (error) { if (top) throw error; unreadable++; return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { if (pruneDir(entry.name, dir)) walk(full, false); }
      else if (entry.isFile() && entry.name.endsWith('.txt')) files.push(full);
    }
  };
  walk(root, true);
  return { files: files.sort(), unreadable };
}

const quote = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;

export async function selfCaptureCheck(engine: BrainEngine, opts: { projectsRoot?: string; corpusDir?: string } = {}): Promise<Check> {
  const name = 'self_capture';
  try {
    const corpusDir = opts.corpusDir ?? await engine.getConfig(CORPUS_KEY);
    if (!corpusDir) return { name, status: 'ok', message: 'No session corpus is configured; nothing to classify.', details: { classified: 0, unclassifiable: 0, count: 'exact', truncated: false } };
    // An unreadable corpus root throws (unknown health); unreadable subdirectories make the counts a lower bound.
    const { files, unreadable } = corpusTextFiles(corpusDir);
    const projectsRoot = opts.projectsRoot ?? claudeProjectsDir();
    const selfIds = claudeCliSelfSessionIds(projectsRoot);
    const known = harnessSessionIds(projectsRoot);
    const classified: string[] = [], unclassifiable: string[] = [];
    for (const file of files) {
      const session = corpusFileSessionId(basename(file));
      if (selfIds.has(session)) classified.push(file);
      else if (!known.has(session)) unclassifiable.push(file);
    }
    const quarantineDir = join(dirname(corpusDir), `${basename(corpusDir)}.quarantine`);
    const destinations = classified.slice(0, SAMPLE).map(file => ({ file, dir: join(quarantineDir, dirname(relative(corpusDir, file))) }));
    const commands = [`mkdir -p ${[...new Set([quarantineDir, ...destinations.map(d => d.dir)])].map(quote).join(' ')}`,
      ...destinations.map(({ file, dir }) => `for f in ${quote(file)}*; do mv -n -- "$f" ${quote(dir)}/; done`)];
    const details = { classified: classified.length, unclassifiable: unclassifiable.length, corpus_files: files.length, unreadable_dirs: unreadable,
      count: unreadable ? 'lower_bound' : 'exact', truncated: classified.length > SAMPLE, ...(unreadable ? { health: 'unknown' } : {}),
      corpus_dir: corpusDir, quarantine_dir: quarantineDir, classified_sample: classified.slice(0, SAMPLE).map(file => relative(corpusDir, file)),
      quarantine_commands: commands, docs: 'docs/guides/repair.md#quarantine-self-captured-corpus-files' };
    const unknownNote = unclassifiable.length ? ` ${unclassifiable.length} corpus file(s) have no harness transcript left, so whether they are self-captures cannot be decided here; review them by hand.` : '';
    if (unreadable) return { name, status: 'warn', details, message: `${unreadable} session corpus director${unreadable === 1 ? 'y' : 'ies'} could not be read, so self-capture health is unknown `
      + `(at least ${classified.length} identified self-capture(s)). Fix the directory permissions on the brain host and rerun gbrain doctor.${unknownNote}` };
    if (!classified.length) return { name, status: 'ok', details, message: `No identified gbrain self-capture remains in the session corpus.${unknownNote}` };
    return { name, status: 'warn', details, message: `${classified.length} session corpus file(s) were captured from gbrain's own claude-cli sessions (#5413). `
      + `Dream and the sweep skip them, but they stay in the corpus until you move them. Nothing was moved or deleted. Quarantine them on the brain host: `
      + `${commands.slice(0, 3).join(' && ')}${classified.length > 2 ? ' … (full list: gbrain doctor --json, check self_capture; recipe: docs/guides/repair.md#quarantine-self-captured-corpus-files)' : ''}.${unknownNote}` };
  } catch (error) {
    return { name, status: 'warn', message: `Self-capture scan could not run: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { count: 'unknown', truncated: true, health: 'unknown' } };
  }
}
