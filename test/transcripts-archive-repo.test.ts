/**
 * GST-2768 PR 2: on a personal brain whose archive source is a git checkout, the archive writes the redacted day
 * pages as files, commits only those paths through `gbrain git commit-push` (a real child CLI, real bare remote),
 * then syncs the checkout so the database converges on git. A second run on the same input changes nothing.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { ARCHIVE_TIMEZONE_KEY, runTranscriptArchive, setArchiveEnabled } from '../src/core/transcripts/archive.ts';
import { withEnv } from './helpers/with-env.ts';
import { archivedPages, conversation, staticReader } from './helpers/transcript-archive.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'transcripts-archive-repo-')));
const identity = { GIT_AUTHOR_NAME: 'Example', GIT_AUTHOR_EMAIL: 'example@example.invalid', GIT_COMMITTER_NAME: 'Example', GIT_COMMITTER_EMAIL: 'example@example.invalid' };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const cli = join(dir, 'gbrain');
const remote = join(dir, 'brain.git');
const root = join(dir, 'brain');
let engine: PGLiteEngine;

beforeAll(async () => {
  writeFileSync(cli, `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, '..', 'src', 'cli.ts')}' "$@"\n`);
  chmodSync(cli, 0o755);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, root], { stdio: 'ignore' });
  git(root, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(root, 'notes'));
  writeFileSync(join(root, 'notes', 'a.md'), '---\ntype: note\ntitle: A\n---\nstart\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'init'); git(root, 'push', '-q', '-u', 'origin', 'main');
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::jsonb)', ['conversations', root, JSON.stringify({ remote_url: remote })]);
}, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(dir, { recursive: true, force: true }); });

test('archive commits only its day files, pushes them, and the synced database matches git', async () => {
  await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
  await setArchiveEnabled(engine, true);
  writeFileSync(join(root, 'notes', 'draft.md'), 'someone else is still editing this\n');
  const readers = [staticReader('codex', [conversation('codex', 'codex-repo-1', [
    ['user', '2026-11-08T08:00:00.000Z', 'plan the garden'], ['assistant', '2026-11-08T08:01:00.000Z', 'tomatoes first'],
    ['user', '2026-11-09T09:00:00.000Z', 'and the beans?'],
  ])])];
  const env = { ...identity, GBRAIN_JOB_CHILD_CLI: cli, GBRAIN_HOME: join(dir, 'home') };
  const result = await withEnv(env, () => runTranscriptArchive(engine, { mode: 'backfill', from: '2026-11-08', to: '2026-11-09', readers, now: new Date('2026-11-12T00:00:00Z') }));
  expect(result.errors).toEqual([]);
  expect(result.write_mode).toBe('repo');
  expect(result.written).toBeGreaterThanOrEqual(2);
  const committed = git(root, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort();
  expect(committed.every(p => p.startsWith('conversations/'))).toBe(true);
  expect(committed.filter(p => p.startsWith('conversations/codex/'))).toHaveLength(2);
  expect(git(root, 'status', '--porcelain', '--', 'notes/draft.md')).toBe('?? notes/draft.md');
  expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(git(root, 'rev-parse', 'HEAD'));
  const pages = await archivedPages(engine);
  for (const p of committed) {
    expect(existsSync(join(root, p))).toBe(true);
    expect(pages.map(x => x.slug)).toContain(p.replace(/\.md$/, ''));
  }
  expect(readFileSync(join(root, committed.find(p => p.includes('/codex/2026-11-08/'))!), 'utf8')).toContain('tomatoes first');
  const head = git(root, 'rev-parse', 'HEAD');
  const again = await withEnv(env, () => runTranscriptArchive(engine, { mode: 'backfill', from: '2026-11-08', to: '2026-11-09', readers, now: new Date('2026-11-12T00:00:00Z') }));
  expect(again.errors).toEqual([]);
  expect(again.written).toBe(0);
  expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
}, 180_000);
