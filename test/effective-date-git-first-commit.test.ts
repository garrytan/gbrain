/**
 * A12: with `sync.git_first_commit_dates` on, an undated page imported from a
 * git checkout takes the file's first-commit date as its effective-date
 * fallback instead of the clone's file timestamps. Off by default; shallow
 * clones fall back to the file timestamps.
 *
 * PGLite in-memory ($0).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { performSync } from '../src/commands/sync.ts';

let engine: PGLiteEngine;
let origin: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  origin = mkdtempSync(join(tmpdir(), 'first-commit-origin-'));
  execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: origin });
  mkdirSync(join(origin, 'notes'));
  writeFileSync(join(origin, 'notes/undated.md'), '---\ntitle: Undated\n---\nAn old undated note.\n');
  writeFileSync(join(origin, 'notes/dated.md'), '---\ntitle: Dated\ndate: 2019-06-01\n---\nA dated note.\n');
  execSync('git add -A && git commit -qm old', { cwd: origin, env: { ...process.env, GIT_AUTHOR_DATE: '2015-04-02T12:00:00Z', GIT_COMMITTER_DATE: '2015-04-02T12:00:00Z' } });
  writeFileSync(join(origin, 'notes/undated.md'), '---\ntitle: Undated\n---\nAn old undated note, edited.\n');
  execSync('git commit -qam edit', { cwd: origin, env: { ...process.env, GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' } });
}, 60_000);

afterAll(async () => { if (engine) await engine.disconnect(); }, 60_000);

async function cloneAndSync(sourceId: string, shallow = false) {
  const clone = mkdtempSync(join(tmpdir(), 'first-commit-clone-'));
  execSync(`git clone -q ${shallow ? '--depth 1 ' : ''}file://${origin} ${clone}`);
  await runSources(engine, ['add', sourceId, '--path', clone, '--no-federated']);
  await performSync(engine, { repoPath: clone, sourceId, noPull: true, noEmbed: true });
  return Object.fromEntries((await engine.executeRaw<{ slug: string; d: string; s: string }>(
    `SELECT slug, to_char(effective_date AT TIME ZONE 'UTC', 'YYYY-MM-DD') d, effective_date_source s FROM pages WHERE source_id = $1`,
    [sourceId])).map(r => [r.slug, `${r.d} ${r.s}`]));
}

describe('git first-commit effective-date fallback', () => {
  test('off by default: an undated clone takes the file timestamp', async () => {
    const pages = await cloneAndSync('fc-off');
    expect(pages['notes/undated']).not.toBe('2015-04-02 fallback');
    expect(pages['notes/undated']).toEndWith(' fallback');
  }, 60_000);

  test('opted in: an undated page takes its first-commit date; dated pages keep theirs', async () => {
    await engine.setConfig('sync.git_first_commit_dates', 'true');
    const pages = await cloneAndSync('fc-on');
    expect(pages['notes/undated']).toBe('2015-04-02 fallback');
    expect(pages['notes/dated']).toBe('2019-06-01 date');
  }, 60_000);

  test('a shallow clone keeps the file timestamp', async () => {
    await engine.setConfig('sync.git_first_commit_dates', 'true');
    const pages = await cloneAndSync('fc-shallow', true);
    expect(pages['notes/undated']).not.toBe('2015-04-02 fallback');
  }, 60_000);
});
