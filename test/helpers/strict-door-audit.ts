/**
 * G6 (git-canonical memory, docs/designs/GIT_CANONICAL_MEMORY.md): what a writer's batch left behind on a strict source
 * (`sources.config.canonical = "git"`). The door (src/core/persistence/git-door.ts) commits each published file before
 * its row, so after a batch every page the writer touched is at HEAD with the bytes its row holds, the tree is clean,
 * the git-gap census (`gbrain sources git-gap`) reports no gap, and the batch made at most one commit per publication
 * group. Read-only: plumbing reads of the checkout and the census.
 */
import { expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { readExportPage, readExportWithdrawals } from '../../src/core/export-snapshot.ts';
import { compareInlineExportFile, type ExportFileComparison } from '../../src/core/persistence/git-gap.ts';
import { censusGitGap, type GitGapCensus } from '../../src/commands/sources-git-gap.ts';
import { PAGE_BATCH_GROUP_MAX } from '../../src/core/persistence/group-publish.ts';
import { gitAsync } from './git-publication.ts';

/** Flags `sourceId` strict (git-canonical), exactly as test/git-door-strict-gbra133.test.ts does. */
export const strictSource = (engine: BrainEngine, sourceId = 'default') =>
  engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id=$1`, [sourceId]);

export const headCommit = async (root: string) => (await gitAsync(root, 'rev-parse', 'HEAD')).trim();

/** The census states that mean the database holds page content Git does not. */
export const GAP_STATES = ['database_ahead', 'worktree_only', 'undeclared_database_only'] as const;

export interface PageAudit {
  slug: string;
  path: string;
  /** The HEAD blob of the page's file, or null when HEAD has none. */
  head: string | null;
  /** The working-tree bytes, or null when the file is absent. */
  worktree: string | null;
  /** The live row against the HEAD blob under the census equality contract (compareInlineExportFile); null without a row or a HEAD blob. */
  row: ExportFileComparison | null;
  /** Commits since the batch started that touch this page's file. */
  commits: number;
}

export interface DoorAudit {
  /** Commits made since `since`, oldest first, each with the paths it touched. */
  commits: Array<{ sha: string; paths: string[] }>;
  /** `git status --porcelain` (untracked files included). */
  porcelain: string;
  census: GitGapCensus;
  gaps: Record<typeof GAP_STATES[number], number>;
  /** Census sample entries in a gap state. */
  gapSample: GitGapCensus['sample'];
  pages: PageAudit[];
}

/**
 * Audits the checkout and the census after a writer's batch. `slugs` are the live pages the batch wrote (their files
 * are `<slug>.md` under `root`); `since` is HEAD before the batch.
 */
export async function auditDoor(engine: BrainEngine, root: string, opts: { since: string; slugs: string[]; sourceId?: string }): Promise<DoorAudit> {
  const sourceId = opts.sourceId ?? 'default';
  const log = (await gitAsync(root, 'log', '--reverse', '--format=@%H', '--name-only', `${opts.since}..HEAD`)).split('\n');
  const commits: DoorAudit['commits'] = [];
  for (const line of log) {
    if (line.startsWith('@')) commits.push({ sha: line.slice(1), paths: [] });
    else if (line.trim()) commits.at(-1)!.paths.push(line.trim());
  }
  const porcelain = await gitAsync(root, 'status', '--porcelain', '--untracked-files=all');
  const census = await censusGitGap(engine, sourceId, { sample: 1000 });
  const gaps = Object.fromEntries(GAP_STATES.map(state => [state, census.states[state]])) as DoorAudit['gaps'];
  const gapSample = census.sample.filter(entry => (GAP_STATES as readonly string[]).includes(entry.state));
  const withdrawals = await engine.transaction(tx => readExportWithdrawals(tx, sourceId));
  const pages: PageAudit[] = [];
  for (const slug of opts.slugs) {
    const path = `${slug}.md`;
    const head = await gitAsync(root, 'show', `HEAD:${path}`).catch(() => null);
    const worktree = existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null;
    const [key] = await engine.executeRaw<{ id: string; source_id: string; slug: string }>(
      'SELECT id::text AS id, source_id, slug FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]);
    const row = key && head !== null ? compareInlineExportFile(Buffer.from(head), path, await engine.transaction(tx => readExportPage(tx, key, withdrawals))) : null;
    pages.push({ slug, path, head, worktree, row, commits: commits.filter(commit => commit.paths.includes(path)).length });
  }
  return { commits, porcelain, census, gaps, gapSample, pages };
}

/** A compact measurement line for a report. */
export function summarizeAudit(label: string, audit: DoorAudit): string {
  const batchPaths = new Set(audit.pages.map(page => page.path));
  return `[g6-measure] ${label}: ${JSON.stringify({
    commits: audit.commits.length,
    commits_touching_batch: audit.commits.filter(commit => commit.paths.some(path => batchPaths.has(path))).length,
    paths_per_commit: audit.commits.map(commit => commit.paths.length),
    clean: audit.porcelain === '',
    porcelain: audit.porcelain.split('\n').filter(Boolean).slice(0, 10),
    census: Object.fromEntries(Object.entries(audit.census.states).filter(([, n]) => n > 0)),
    gap_sample: audit.gapSample.slice(0, 10).map(entry => ({ slug: entry.slug, state: entry.state, fields: entry.fields, worktree: entry.worktree })),
    rows_without_git_home: audit.census.rows_without_git_home,
    pages: audit.pages.map(page => ({ slug: page.slug, at_head: page.head !== null, row_vs_head: page.row,
      head_equals_worktree: page.head === page.worktree, commits: page.commits })),
  })}`;
}

/**
 * The G6 target for one writer batch on a strict source:
 *   - every page is at HEAD, the working tree holds the same bytes, and the row equals the HEAD blob (the census
 *     equality contract, compareInlineExportFile: the row holds no content HEAD does not);
 *   - `git status --porcelain` is empty;
 *   - the census has no page in database_ahead, worktree_only or undeclared_database_only;
 *   - the batch made at most one commit per publication group, and no page was committed twice. One writer batch is
 *     one group of up to PAGE_BATCH_GROUP_MAX pages on Postgres (group-publish.ts, as put_pages). PGLite's consumer
 *     groups only managed import batches (consumer.ts executeOrGroup), so there each page is its own publication, as
 *     test/git-door-strict-gbra133.test.ts accepts for put_pages.
 */
export function expectDoorTarget(audit: DoorAudit, backend: BrainEngine['kind']): void {
  for (const page of audit.pages) {
    expect({ slug: page.slug, atHead: page.head !== null }).toEqual({ slug: page.slug, atHead: true });
    expect({ slug: page.slug, worktree: page.worktree }).toEqual({ slug: page.slug, worktree: page.head });
    expect({ slug: page.slug, row: page.row }).toEqual({ slug: page.slug, row: { state: 'equal' } });
  }
  expect(audit.porcelain).toBe('');
  expect({ gaps: audit.gaps, sample: audit.gapSample }).toEqual({ gaps: { database_ahead: 0, worktree_only: 0, undeclared_database_only: 0 }, sample: [] });
  const groups = backend === 'postgres' ? Math.max(1, Math.ceil(audit.pages.length / PAGE_BATCH_GROUP_MAX)) : audit.pages.length;
  const batchPaths = new Set(audit.pages.map(page => page.path));
  expect(audit.commits.filter(commit => commit.paths.some(path => batchPaths.has(path))).length).toBeLessThanOrEqual(groups);
  expect(audit.pages.filter(page => page.commits > 1).map(page => ({ slug: page.slug, commits: page.commits }))).toEqual([]);
}
