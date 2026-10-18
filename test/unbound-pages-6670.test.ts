/**
 * #6670: `slugDerivedOrigin` only built `<slug>.md`, so a page whose file is
 * `HEARTBEAT.md` (the importer lowercases it into page `heartbeat`) pointed at
 * a file that does not exist on a case-sensitive filesystem, and
 * `sources reconcile --adopt-slug-path` refused it as missing. The lookup now
 * reads the slug's directory chain case-insensitively and returns the on-disk
 * spelling.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { slugDerivedOrigin } from '../src/core/persistence/unbound-pages.ts';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function root(files: string[]): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-6670-'))); dirs.push(dir);
  for (const file of files) { mkdirSync(join(dir, file, '..'), { recursive: true }); writeFileSync(join(dir, file), '# Heartbeat\n'); }
  return dir;
}

test('a file that differs from its slug only by case is the origin, with its on-disk spelling', () => {
  const dir = root(['HEARTBEAT.md', 'Notes/Daily/Standup.md']);
  expect(slugDerivedOrigin(dir, 'heartbeat', 'source-root')).toEqual({ path: join(dir, 'HEARTBEAT.md'), sourcePath: 'HEARTBEAT.md' });
  expect(slugDerivedOrigin(dir, 'notes/daily/standup', 'source-root')).toEqual({ path: join(dir, 'Notes/Daily/Standup.md'), sourcePath: 'Notes/Daily/Standup.md' });
});

test('an exactly spelled file wins over a case variant, as the importer keeps <slug>.md on a collision', () => {
  const dir = root(['heartbeat.md', 'HEARTBEAT.md']);
  expect(slugDerivedOrigin(dir, 'heartbeat', 'source-root')).toEqual({ path: join(dir, 'heartbeat.md'), sourcePath: 'heartbeat.md' });
});

test('several case variants and no exact spelling refuse slug_path_ambiguous naming each', () => {
  const dir = root(['HEARTBEAT.md', 'Heartbeat.md']);
  let error: { code?: string; detail?: string; suggestion?: string } | undefined;
  try { slugDerivedOrigin(dir, 'heartbeat', 'source-root'); } catch (caught) { error = caught as typeof error; }
  expect(error).toMatchObject({ code: 'source_changed', detail: 'slug_path_ambiguous' });
  expect(error!.suggestion).toContain('HEARTBEAT.md');
  expect(error!.suggestion).toContain('Heartbeat.md');
});

test('no match keeps the expected path, and a symlink is never adopted', () => {
  const dir = root(['other.md']);
  symlinkSync(join(dir, 'other.md'), join(dir, 'HEARTBEAT.md'));
  expect(slugDerivedOrigin(dir, 'heartbeat', 'source-root')).toEqual({ path: join(dir, 'heartbeat.md'), sourcePath: 'heartbeat.md' });
});
