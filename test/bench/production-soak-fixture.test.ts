import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixture, type FixtureOptions } from '../../scripts/bench/production-soak/fixture.ts';

const OPTS: FixtureOptions = { pages: 3000, seed: 11, years: 2, backlogDays: 14, hugeMb: 0.05, oversized: 0 };
const git = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();

describe('production soak fixture', () => {
  const a = mkdtempSync(join(tmpdir(), 'soak-fixture-a-'));
  const b = mkdtempSync(join(tmpdir(), 'soak-fixture-b-'));
  const ma = buildFixture(OPTS, a) as any;
  const mb = buildFixture(OPTS, b) as any;

  test('the same seed and size give the same commits and drift', () => {
    expect(ma.sources.map((s: any) => s.head)).toEqual(mb.sources.map((s: any) => s.head));
    expect(ma.sources.map((s: any) => s.import_base)).toEqual(mb.sources.map((s: any) => s.import_base));
    expect(readFileSync(join(a, 'drift.jsonl'), 'utf8')).toBe(readFileSync(join(b, 'drift.jsonl'), 'utf8'));
    expect(ma.pages).toBe(mb.pages);
  });

  test('the main source carries years of moves, archive culls, deletes and merged side branches', () => {
    const main = ma.sources.find((s: any) => s.id === 'default');
    const repo = main.repo;
    expect(main.merges).toBeGreaterThan(10);
    expect(main.moved).toBeGreaterThan(0);
    expect(main.culled).toBeGreaterThan(0);
    expect(main.deleted).toBeGreaterThan(0);
    expect(main.side_deleted).toBeGreaterThan(0);
    expect(Number(git(repo, 'rev-list', '--count', '--merges', 'final'))).toBe(main.merges);
    const paths = git(repo, 'ls-tree', '-r', '--name-only', 'final').split('\n');
    expect(paths.some(p => /^archive\/\d{4}\//.test(p))).toBe(true);
    expect(paths.some(p => p.startsWith('connectors/'))).toBe(true);
    expect(paths.some(p => p.startsWith('timelines/'))).toBe(true);
    const first = git(repo, 'log', '--reverse', '--format=%ad', '--date=short', 'final').split('\n')[0]!;
    const last = git(repo, 'log', '-1', '--format=%ad', '--date=short', 'final');
    expect(Number(last.slice(0, 4)) - Number(first.slice(0, 4))).toBeGreaterThanOrEqual(1);
  });

  test('the backlog after import-base commits the files gbrain must hold', () => {
    const repo = ma.sources.find((s: any) => s.id === 'default').repo;
    const backlog = git(repo, 'diff', '--name-only', 'import-base', 'final').split('\n');
    for (const f of ma.problem_files) expect(backlog).toContain(f.path);
    expect(new Set(ma.problem_files.map((f: any) => f.expect))).toEqual(new Set(['invalid_frontmatter', 'invalid_fence', 'frontmatter_slug_conflict']));
  });

  test('private, alias-private and connector pages are present, and every canary is listed as private', () => {
    const main = ma.sources.find((s: any) => s.id === 'default');
    expect(main.private.visibility).toBeGreaterThan(0);
    expect(main.private.access).toBeGreaterThan(0);
    expect(main.private.confidentiality).toBeGreaterThan(0);
    expect(main.kinds.connector).toBeGreaterThan(0);
    const tokens = new Set(JSON.parse(readFileSync(join(a, 'private-tokens.json'), 'utf8')) as string[]);
    for (const c of ma.privacy.canaries) { expect(tokens.has(c.token)).toBe(true); expect(tokens.has(c.page_token)).toBe(true); }
    const sample = ma.privacy.canaries[0];
    const file = git(main.repo, 'show', 'final:' + sample.slug + '.md');
    expect(file).toContain(sample.token);
    expect(/^(visibility: private|access: (private|restricted|confidential)|confidentiality: secret)$/m.test(file)).toBe(true);
  });

  test('the drift holds database-only pages no commit held and kept pages whose files history deleted', () => {
    const rows = readFileSync(join(a, 'drift.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const repo = ma.sources.find((s: any) => s.id === 'default').repo;
    const dbOnly = rows.filter(r => r.kind === 'db_only'), kept = rows.filter(r => r.kind === 'kept_deleted');
    expect(dbOnly.length).toBeGreaterThan(0);
    expect(kept.length).toBeGreaterThan(0);
    expect(git(repo, 'log', '--all', '--format=%h', '--', dbOnly[0].path)).toBe('');
    const tip = git(repo, 'ls-tree', '-r', '--name-only', 'final').split('\n');
    for (const r of kept) { expect(tip).not.toContain(r.path); expect(git(repo, 'log', '--all', '--format=%h', '-1', '--', r.path)).not.toBe(''); }
    expect(kept.some(r => r.side_branch)).toBe(true);
  });

  test('cleanup', () => { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); });
});
