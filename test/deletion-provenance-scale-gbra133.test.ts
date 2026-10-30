/**
 * GBRA-133: deletion provenance and origin evidence read a long history once. Before, each read walked the history once per
 * 500 paths with a pathspec (`git log --full-history -- <500 paths>`); on a history of about 20,000 commits every walk ran
 * past its 120 s limit, so a preview of about 2,000 held files sat silent for many minutes and answered `unknown` for whole
 * batches (a round 1,000), and the database-only keep re-walked the history for every page it applied. Now one walk per
 * commit (`historyIndex`, extended by the commits after a cached one) answers every path, HEAD's own files read
 * `deletion_uncommitted` even when an older commit deleted and re-added them, and the walk reports its progress.
 * Real Git; the long history is written with `git fast-import`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDeletionProvenance, readOriginEvidence } from '../src/core/persistence/sync-origin-evidence.ts';

const dirs: string[] = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'gbrain-provenance-scale-')); dirs.push(dir); return dir; };
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, 'commit', '-qm', message); };
const kinds = (read: Map<string, { kind: string }>) => Object.fromEntries([...read].map(([path, found]) => [path, found.kind]));

describe('GBRA-133: one history walk answers every path', () => {
  test('a file HEAD holds again reads deletion_uncommitted; a later deletion names the newer commit; batches past 500 paths', async () => {
    const root = scratch();
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q', '-b', 'main');
    for (let i = 0; i < 1200; i++) writeFileSync(join(root, `notes/n${i}.md`), `${i}\n`);
    writeFileSync(join(root, 'notes/back.md'), 'one\n');
    commit(root, 'init');
    git(root, 'rm', '-q', 'notes/back.md'); git(root, 'commit', '-qm', 'drop back');
    writeFileSync(join(root, 'notes/back.md'), 'two\n'); commit(root, 'restore back');
    git(root, 'rm', '-q', '-r', 'notes/n1*'); git(root, 'commit', '-qm', 'cull n1');
    rmSync(join(root, 'notes/back.md'));
    const paths = ['notes/back.md', ...Array.from({ length: 1200 }, (_, i) => `notes/n${i}.md`).filter(path => path.startsWith('notes/n1')), 'notes/never.md'];
    expect(paths.length).toBeGreaterThan(200);
    const many = Array.from({ length: 700 }, (_, i) => `notes/missing${i}.md`);
    const first = await readDeletionProvenance(root, [...paths, ...many]);
    expect(first.get('notes/back.md')).toEqual({ kind: 'deletion_uncommitted' });
    expect(first.get('notes/n1.md')).toMatchObject({ kind: 'deleted_by_commit', subject: 'cull n1' });
    expect(first.get('notes/never.md')).toEqual({ kind: 'never_committed' });
    expect(new Set(many.map(path => first.get(path)!.kind))).toEqual(new Set(['never_committed']));

    // A newer commit deletes back.md for good: the cached walk is extended, and the newest deleting commit is named.
    git(root, 'rm', '-q', '--cached', 'notes/back.md'); git(root, 'commit', '-qm', 'drop back again');
    const second = await readDeletionProvenance(root, ['notes/back.md', 'notes/n1.md']);
    expect(second.get('notes/back.md')).toMatchObject({ kind: 'deleted_by_commit', subject: 'drop back again', commit: git(root, 'rev-parse', 'HEAD') });
    expect(second.get('notes/n1.md')).toMatchObject({ kind: 'deleted_by_commit', subject: 'cull n1' });

    // Origin evidence: a baseline that is an ancestor of the target adds nothing; a path only a newer commit touched is
    // not committed in an older target's history.
    const old = git(root, 'rev-parse', 'HEAD~3');
    writeFileSync(join(root, 'notes/late.md'), 'late\n'); commit(root, 'late');
    git(root, 'rm', '-q', 'notes/late.md'); git(root, 'commit', '-qm', 'drop late');
    const head = git(root, 'rev-parse', 'HEAD');
    expect(Object.fromEntries(await readOriginEvidence(root, [head, old], ['notes/late.md', 'notes/n1.md', 'notes/never.md'])))
      .toEqual({ 'notes/late.md': 'committed', 'notes/n1.md': 'committed', 'notes/never.md': 'never_committed' });
    expect(Object.fromEntries(await readOriginEvidence(root, [old], ['notes/late.md', 'notes/n1.md'])))
      .toEqual({ 'notes/late.md': 'never_committed', 'notes/n1.md': 'committed' });
  });

  test('about 1,800 held files over a 20,000-commit history resolve in one walk, with progress', async () => {
    const root = scratch();
    spawnSync('git', ['init', '-q', '-b', 'main', root]);
    const COMMITS = 20_000, FILES = 4_000, lines: string[] = [], live = new Set<number>();
    for (let c = 0; c < COMMITS; c++) {
      lines.push('commit refs/heads/main', `mark :${c + 1}`, `committer Example <example@example.invalid> ${1_700_000_000 + c * 60} +0000`, `data ${`c${c}`.length}`, `c${c}`);
      if (c > 0) lines.push(`from :${c}`);
      for (let k = 0; k < 3; k++) {
        const file = (c * 7 + k * 13) % FILES;
        if (live.has(file) && (c + k) % 5 === 0) { lines.push(`D notes/f${file}.md`); live.delete(file); continue; }
        const body = `v${c}\n`;
        lines.push(`M 100644 inline notes/f${file}.md`, `data ${body.length}`, body); live.add(file);
      }
      lines.push('');
    }
    const imported = spawnSync('git', ['-C', root, 'fast-import', '--quiet'], { input: lines.join('\n') + '\n', maxBuffer: 1 << 30 });
    expect(imported.status).toBe(0);
    git(root, 'checkout', '-q', 'main');
    const gone = Array.from({ length: FILES }, (_, i) => i).filter(i => !live.has(i)).map(i => `notes/f${i}.md`);
    const never = Array.from({ length: 1000 }, (_, i) => `notes/never${i}.md`);
    let heard = 0;
    const read = await readDeletionProvenance(root, [...gone, ...never], { onCommit: commits => { heard = commits; } });
    expect(gone.length).toBeGreaterThan(500);
    expect(new Set(gone.map(path => read.get(path)!.kind))).toEqual(new Set(['deleted_by_commit']));
    expect(new Set(never.map(path => read.get(path)!.kind))).toEqual(new Set(['never_committed']));
    expect(heard).toBeGreaterThanOrEqual(COMMITS - 1000);
    expect(kinds(await readDeletionProvenance(root, [gone[0]!, never[0]!]))).toEqual({ [gone[0]!]: 'deleted_by_commit', [never[0]!]: 'never_committed' });
  }, 120_000);
});
