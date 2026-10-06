/**
 * Static-file delivery of always-loaded core memory (`gbrain compile-context
 * --include-core`): git safety for the output path and a small local record
 * of every compiled file that carries core, so `gbrain doctor` can name
 * stale or leftover copies and the command that refreshes them.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { atomicWriteTextFile } from '../bootstrap/atomic-write.ts';
import { resolveGbrainHome } from '../gbrain-home.ts';

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export function gitRoot(cwd: string): string | null {
  return git(cwd, ['rev-parse', '--show-toplevel']);
}

/** True when the file is tracked by the git repository that contains it. */
export function isGitTracked(path: string): boolean {
  const dir = dirname(resolve(path));
  if (!existsSync(dir)) return false;
  return git(dir, ['ls-files', '--error-unmatch', '--', resolve(path)]) !== null;
}

/** Adds the path to the repository's local exclude file (never .gitignore, which is shared). */
export function ensureGitExcluded(path: string): void {
  const root = gitRoot(dirname(resolve(path)));
  if (!root) return;
  const excludeRel = git(root, ['rev-parse', '--git-path', 'info/exclude']);
  if (!excludeRel) return;
  const exclude = isAbsolute(excludeRel) ? excludeRel : join(root, excludeRel);
  const entry = `/${relative(root, resolve(path)).split('\\').join('/')}`;
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (current.split('\n').some(line => line.trim() === entry)) return;
  appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}${entry}\n`);
}

export interface CompiledCoreRecord {
  path: string;
  target: string;
  source_id: string;
  revision: string;
  command: string;
  compiled_at: string;
}

function recordFile(): string {
  return join(resolveGbrainHome(), 'compiled-core.json');
}

export function readCompiledCoreRecords(): CompiledCoreRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(recordFile(), 'utf8')) as { files?: CompiledCoreRecord[] };
    return Array.isArray(parsed.files) ? parsed.files : [];
  } catch {
    return [];
  }
}

/** Upserts (record) or drops (null) the entry for one output path. Best-effort. */
export function updateCompiledCoreRecord(path: string, record: Omit<CompiledCoreRecord, 'path' | 'compiled_at'> | null): void {
  try {
    const abs = resolve(path);
    const files = readCompiledCoreRecords().filter(r => r.path !== abs);
    if (record) files.push({ ...record, path: abs, compiled_at: new Date().toISOString() });
    atomicWriteTextFile(recordFile(), `${JSON.stringify({ files }, null, 2)}\n`, { freshMode: 0o600 });
  } catch { /* observability only */ }
}

/** Reads `core_revision=` from a compiled file's header line; null when the file has no core. */
export function compiledCoreRevision(text: string): string | null {
  const m = /<!-- gbrain:compiled-context [^\n]*core_revision=([0-9a-f]+|disabled)/.exec(text);
  return m ? m[1]! : null;
}
