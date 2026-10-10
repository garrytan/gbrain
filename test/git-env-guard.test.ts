/**
 * CSO G4 guard (wave 13): every Git child process under `src/core` builds its env
 * through a helper that drops Git's repository-locating variables (`gitChildEnv`,
 * or the stricter `backupGitEnv` / `hardenedGitEnvironment`). A new spawn that
 * inherits `process.env` (implicitly or with `...process.env`) fails here.
 * PENDING lists files owned by another lane; each is a named hunk request and
 * leaves the list once that lane adopts the helper.
 */
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const HELPERS = /\benv\s*:\s*(?:\{\s*\.\.\.)?(gitChildEnv|backupGitEnv|hardenedGitEnvironment)\(/;
const SPAWN = /\b(spawnSync|spawn|execFileSync|execFileBounded|execFile)\(\s*['"]git['"]\s*,|\bBun\.spawn(Sync)?\(\s*\[\s*['"]git['"]/g;
/** GBRA-75 (wave 10) owns these; the hunk request adopts gitChildEnv after wave 10 merges. */
const PENDING = new Set(['src/core/sync-git.ts', 'src/core/git-visible-files.ts', 'src/core/fence-repair/census.ts']);

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out);
    else if (name.endsWith('.ts') && !name.includes('.generated.')) out.push(path);
  }
  return out;
}

/** The call's full text from its opening parenthesis, skipping string and template contents. */
function callText(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i]!;
    if (c === '\'' || c === '"' || c === '`') {
      for (i++; i < source.length && source[i] !== c; i++) if (source[i] === '\\') i++;
    } else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (--depth === 0) return source.slice(open, i + 1); }
  }
  return source.slice(open);
}

export function unscrubbedGitSpawns(path: string, source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(SPAWN)) {
    const call = callText(source, source.indexOf('(', match.index!));
    const named = /,\s*([A-Za-z_$][\w$]*)\s*\)$/.exec(call)?.[1];
    const scrubbed = HELPERS.test(call) || (named !== undefined && new RegExp(`\\b${named}\\s*=\\s*\\{[^;]*${HELPERS.source}`).test(source));
    if (!scrubbed || /\.\.\.\s*process\.env\b/.test(call)) found.push(`${path}:${source.slice(0, match.index).split('\n').length}`);
  }
  return found;
}

test('every Git spawn under src/core scrubs repository-locating variables', () => {
  const offenders = files(join(ROOT, 'src/core')).flatMap(file => {
    const rel = relative(ROOT, file).split('\\').join('/');
    return PENDING.has(rel) ? [] : unscrubbedGitSpawns(rel, readFileSync(file, 'utf8'));
  });
  expect(offenders).toEqual([]);
});

test('the guard catches implicit and explicit process.env inheritance and accepts the helpers', () => {
  expect(unscrubbedGitSpawns('x.ts', "execFileSync('git', ['status'], { encoding: 'utf8' });")).toEqual(['x.ts:1']);
  expect(unscrubbedGitSpawns('x.ts', "spawnSync('git', ['status']);")).toEqual(['x.ts:1']);
  expect(unscrubbedGitSpawns('x.ts', "execFile('git', args, { env: { ...process.env, A: '1' } });")).toEqual(['x.ts:1']);
  expect(unscrubbedGitSpawns('x.ts', "Bun.spawn(['git', 'status'], { env: process.env });")).toEqual(['x.ts:1']);
  expect(unscrubbedGitSpawns('x.ts', "execFileSync('git', ['status'], { env: gitChildEnv({ A: ')' }) });")).toEqual([]);
  expect(unscrubbedGitSpawns('x.ts', "const opts = { stdio: 'ignore', env: gitChildEnv() };\nexecFileSync('git', ['add'], opts);")).toEqual([]);
  expect(unscrubbedGitSpawns('x.ts', "spawnSync('git', HARDENED, { env: hardenedGitEnvironment() });")).toEqual([]);
});

test('PENDING names only files that still need the hunk', () => {
  for (const rel of PENDING) expect({ rel, unscrubbed: unscrubbedGitSpawns(rel, readFileSync(join(ROOT, rel), 'utf8')).length > 0 }).toEqual({ rel, unscrubbed: true });
});
