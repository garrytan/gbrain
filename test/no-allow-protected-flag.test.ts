/**
 * #6196 — there is no allow-protected flag. `gbrain jobs submit` sets the
 * protected-job opt-in itself for protected names, so every comment, skill or
 * migration note that tells an operator to pass the flag sends an agent to a
 * command line that does not mean what it says. One repo-wide guard over
 * src/, skills/ and test/ (CHANGELOG history excluded) keeps it from coming
 * back. The needle is assembled at runtime so this file does not match itself.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const FLAG = ['--allow', 'protected'].join('-');
const FLAG_RE = new RegExp(`${FLAG}(?![\\w-])`);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : files(p);
    return /\.(ts|tsx|mjs|js|md|json|sh)$/.test(e.name) ? [p] : [];
  });
}

describe(`no ${FLAG} flag references`, () => {
  it('src/, skills/ and test/ never mention the nonexistent flag', () => {
    const hits = ['src', 'skills', 'test'].flatMap(d => files(join(ROOT, d))).flatMap(file =>
      readFileSync(file, 'utf8').split('\n').flatMap((line, i) => (FLAG_RE.test(line) ? [`${relative(ROOT, file)}:${i + 1}`] : [])));
    expect(hits).toEqual([]);
  });
});
