/**
 * G6 measurement: what a writer's batch leaves on a strict (canonical: git) source. Git is the parent there, so after
 * a batch every page the batch wrote must be committed at HEAD with the exact bytes the door published, the working tree
 * must be clean, the git-gap census must report no gap, and the batch may make at most one door commit per publication
 * group (journal.ts publicationGroupKey; an ungrouped write is a group of one).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { censusGitGap, type GitGapCensus } from '../../src/commands/sources-git-gap.ts';
import { publicationGroupKey } from '../../src/core/persistence/journal.ts';
import { durableGitRepo, git } from './git-publication.ts';

export const strictSource = (engine: BrainEngine, sourceId = 'default') =>
  engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id=$1`, [sourceId]);

/** A Git checkout at `root` with one initial commit, so the door has a HEAD to commit on. */
export function initStrictCheckout(root: string): void {
  writeFileSync(join(root, '.gitignore'), '\n');
  durableGitRepo(root, ['.gitignore']);
}

export const head = (root: string) => git(root, 'rev-parse', 'HEAD').trim();

export interface BatchMeasure {
  /** Commits on HEAD made since `base`, oldest first, each with the files it touched. */
  commits: { sha: string; files: string[] }[];
  /** The publication groups of the batch's committed requests: group key, or the request id for an ungrouped write. */
  groups: number;
  /** Distinct `outcome.persistence.git_commit` stamps on the batch's receipts (null: a receipt with no door commit). */
  receiptCommits: (string | null)[];
  porcelain: string;
  census: GitGapCensus;
  /** Census page states other than equal and declared_database_only, with their counts. */
  gaps: Record<string, number>;
  /** Pages of the batch with no live row, no file at HEAD, or a HEAD blob that differs from the working-tree file. */
  notAtHead: { slug: string; path: string; reason: string }[];
}

/** Measures the batch that wrote `slugs` to `sourceId`, whose checkout is `root`, against the commit `base` taken before it. */
export async function measureBatch(engine: BrainEngine, sourceId: string, root: string, base: string, slugs: string[]): Promise<BatchMeasure> {
  const commits = git(root, 'rev-list', '--reverse', `${base}..HEAD`).split('\n').filter(Boolean)
    .map(sha => ({ sha, files: git(root, 'show', '--name-only', '--format=', sha).split('\n').filter(Boolean) }));
  const requests = await engine.executeRaw<{ request_id: string; operation: string; intent: Record<string, unknown> | null; outcome: Record<string, any> | null }>(
    "SELECT request_id, operation, intent, outcome FROM persistence_requests WHERE source_id=$1 AND slug = ANY($2::text[]) AND state='committed'", [sourceId, slugs]);
  const groups = new Set(requests.map(row => publicationGroupKey(row as never) ?? row.request_id));
  const receiptCommits = [...new Set(requests.map(row => (row.outcome?.persistence?.git_commit as string | undefined) ?? null))];
  const porcelain = git(root, 'status', '--porcelain', '--untracked-files=all');
  const census = await censusGitGap(engine, sourceId, { sample: 100 });
  const gaps = Object.fromEntries(Object.entries(census.states).filter(([state, n]) => n > 0 && state !== 'equal' && state !== 'declared_database_only'));
  const rows = await engine.executeRaw<{ slug: string; source_path: string | null }>(
    'SELECT slug, source_path FROM pages WHERE source_id=$1 AND slug = ANY($2::text[]) AND deleted_at IS NULL', [sourceId, slugs]);
  const notAtHead: BatchMeasure['notAtHead'] = [];
  for (const slug of slugs) {
    const row = rows.find(r => r.slug === slug);
    if (!row) { notAtHead.push({ slug, path: '', reason: 'no live row' }); continue; }
    const path = row.source_path ?? `${slug}.md`;
    let committed: string | null = null;
    try { committed = git(root, 'show', `HEAD:${path}`); } catch { committed = null; }
    let disk: string | null = null;
    try { disk = readFileSync(join(root, path), 'utf8'); } catch { disk = null; }
    if (committed === null) notAtHead.push({ slug, path, reason: disk === null ? 'no file at HEAD or on disk' : 'file not at HEAD' });
    else if (disk !== committed) notAtHead.push({ slug, path, reason: 'working tree differs from HEAD' });
  }
  return { commits, groups: groups.size, receiptCommits, porcelain, census, gaps, notAtHead };
}

/** One line per measurement, printed by each test for the report. */
export function describeMeasure(writer: string, m: BatchMeasure): string {
  return `[G6 ${writer}] commits=${m.commits.length} ${JSON.stringify(m.commits.map(c => c.files))} groups=${m.groups} receipt_commits=${JSON.stringify(m.receiptCommits)}`
    + ` porcelain=${JSON.stringify(m.porcelain)} gaps=${JSON.stringify(m.gaps)} worktree=${JSON.stringify(m.census.worktree)}`
    + ` not_at_head=${JSON.stringify(m.notAtHead)} sample=${JSON.stringify(m.census.sample.filter(s => s.state !== 'equal'))}`;
}

/** The target every G6 writer is held to on a strict source. */
export function expectDoorOnly(m: BatchMeasure, expect: (value: unknown) => any): void {
  expect(m.notAtHead).toEqual([]);
  expect(m.porcelain).toBe('');
  expect(m.gaps).toEqual({});
  expect(m.receiptCommits).not.toContain(null);
  expect(m.commits.length).toBeGreaterThan(0);
  expect(m.commits.length).toBeLessThanOrEqual(m.groups);
}
