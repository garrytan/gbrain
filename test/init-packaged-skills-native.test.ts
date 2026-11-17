/**
 * #5475 end to end: a fresh `foresights init --pglite` publishes the packaged
 * memory skills through the canonical skill-bundle journal. On Windows the
 * unguarded bundle directory flush and the exact POSIX mode compare failed
 * this step ("Skill publication requires bounded regular files ..."), so
 * init never completed. Runs natively on every OS row of the
 * security-regressions job, windows-latest included.
 */
import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-init-skills-')));
afterAll(() => rmSync(home, { recursive: true, force: true }));

function skillFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...skillFiles(path));
    else if (name === 'SKILL.md') found.push(path);
  }
  return found;
}

test('fresh PGLite init publishes the packaged memory skills on this platform', () => {
  const env: NodeJS.ProcessEnv = { ...process.env, GBRAIN_HOME: home };
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'DATABASE_URL', 'GBRAIN_DATABASE_URL']) delete env[key];
  const result = spawnSync(process.execPath, ['run', join(import.meta.dir, '..', 'src', 'cli.ts'), 'init', '--pglite', '--non-interactive', '--no-embedding'],
    { env, encoding: 'utf8', timeout: 120_000 });
  expect({ status: result.status, stderr: result.status === 0 ? '' : result.stderr }).toEqual({ status: 0, stderr: '' });
  const skills = skillFiles(join(home, '.gbrain', 'content')).map(path => path.split(/[\\/]/).at(-2)).sort();
  expect(skills).toEqual(expect.arrayContaining(['memory-recall']));
}, 150_000);
