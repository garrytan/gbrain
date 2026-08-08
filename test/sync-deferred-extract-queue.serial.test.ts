/**
 * #2849 — a sync above the size gate (totalChanges > 100) must leave link
 * extraction DURABLY QUEUED, not just hinted.
 *
 * PR #2850 fixed the sub-gate case (webhook + trigger submit noExtract:false),
 * but above the gate performSync only printed a "deferring link/timeline
 * extraction" hint and left `links_extracted_at` unstamped. The autopilot
 * cycle's extract phase is slug-scoped (runExtractCore({slugs:
 * syncPagesAffected})), so the NEXT cycle's up_to_date sync hands it an empty
 * slug list and it processes 0 pages — the staleness is permanent until an
 * operator runs `gbrain extract --stale` by hand.
 *
 * Post-fix, the deferral branch submits a source-scoped `extract` minion job
 * with { stale: true }, bound to the consumed commit via idempotency key, and
 * the extract handler routes stale jobs through extractStaleFromDB. These
 * tests FAIL on master: no job row exists after a >100-file sync, and the
 * handler ignores { stale: true } (it would walk a directory instead).
 *
 * Marked .serial.test.ts — spawns git subprocesses + shares one PGLite engine.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let repoPath: string;
// resetPgliteState truncates the config table, wiping the `version` key
// MinionQueue.ensureSchema gates on — captured once and reseeded per test.
let schemaVersion: string | null = null;

function git(cmd: string): void { execSync(cmd, { cwd: repoPath, stdio: 'pipe' }); }

function headCommit(): string {
  return execSync('git rev-parse HEAD', { cwd: repoPath }).toString().trim();
}

async function stampOf(slug: string): Promise<string | null> {
  const rows = await engine.executeRaw<{ links_extracted_at: string | null }>(
    `SELECT links_extracted_at FROM pages WHERE slug = $1 AND source_id = 'default'`, [slug],
  );
  return rows[0]?.links_extracted_at ?? null;
}

async function staleExtractJobs(): Promise<Array<{ id: number; name: string; data: Record<string, unknown>; idempotency_key: string | null }>> {
  const rows = await engine.executeRaw<{ id: number; name: string; data: unknown; idempotency_key: string | null }>(
    `SELECT id, name, data, idempotency_key FROM minion_jobs WHERE name = 'extract'`,
  );
  return rows
    .map(r => ({
      ...r,
      data: (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as Record<string, unknown>,
    }))
    .filter(r => r.data.stale === true);
}

/** Seed repo with an initial commit, then add `n` pages that link to people/alice. */
function writeLinkedPages(n: number): void {
  mkdirSync(join(repoPath, 'notes'), { recursive: true });
  for (let i = 0; i < n; i++) {
    writeFileSync(join(repoPath, `notes/page-${i}.md`), [
      '---', 'type: concept', `title: Page ${i}`, '---', '',
      `[Alice](../people/alice.md) appears in note ${i}.`,
    ].join('\n'));
  }
}

describe('#2849 — size-gated sync durably queues the deferred extraction', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    schemaVersion = await engine.getConfig('version');
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  beforeEach(async () => {
    await resetPgliteState(engine);
    if (schemaVersion) await engine.setConfig('version', schemaVersion);
    await engine.executeRaw(`DELETE FROM minion_jobs`).catch(() => {});
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-defer-'));
    execSync('git init', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "t@t.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: repoPath, stdio: 'pipe' });
    mkdirSync(join(repoPath, 'people'), { recursive: true });
    writeFileSync(join(repoPath, 'people/alice.md'), [
      '---', 'type: person', 'title: Alice', '---', '', 'Alice is a founder.',
    ].join('\n'));
    git('git add -A && git commit -m "initial"');
    const { performSync } = await import('../src/commands/sync.ts');
    await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });
  });

  afterEach(() => {
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  test('>100-change sync submits a commit-bound, source-scoped stale-extract job', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    writeLinkedPages(101);
    git('git add -A && git commit -m "big drop"');
    const result = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(['synced', 'first_sync']).toContain(result.status);

    // Above the gate: no inline extract, page unstamped (pre-existing, by design).
    expect(await stampOf('notes/page-0')).toBeNull();

    // THE FIX: the deferral is banked as a durable minion job…
    const jobs = await staleExtractJobs();
    expect(jobs.length).toBe(1);
    // …bound to the consumed commit so webhook redeliveries coalesce…
    expect(jobs[0].idempotency_key).toBe(`extract-stale:default:${headCommit()}`);
    expect(jobs[0].data.deferred_commit).toBe(headCommit());
    // …and it carries an explicit wall-clock budget covering the sweep.
    const rows = await engine.executeRaw<{ timeout_ms: number | null }>(
      `SELECT timeout_ms FROM minion_jobs WHERE id = $1`, [jobs[0].id],
    );
    expect(rows[0].timeout_ms).toBeGreaterThanOrEqual(30 * 60 * 1000);
  }, 120_000);

  test('re-syncing the same commit does not pile up duplicate jobs', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    writeLinkedPages(101);
    git('git add -A && git commit -m "big drop"');
    await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    // Force a re-run over the same commit range (fresh anchor → same head).
    await engine.executeRaw(`UPDATE sources SET last_commit = NULL`).catch(() => {});
    await engine.setConfig('sync.last_commit', '');
    await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });
    const jobs = await staleExtractJobs();
    expect(jobs.length).toBeLessThanOrEqual(1);
  }, 120_000);

  test('sub-gate sync does NOT queue a stale-extract job (inline extract still owns it)', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    writeLinkedPages(3);
    git('git add -A && git commit -m "small drop"');
    await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(await staleExtractJobs()).toHaveLength(0);
    // Inline path stamped the pages (the #1696 contract, unchanged).
    expect(await stampOf('notes/page-0')).not.toBeNull();
  }, 120_000);

  test('--no-extract suppresses the queued job too', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    writeLinkedPages(101);
    git('git add -A && git commit -m "big drop"');
    await performSync(engine, { repoPath, noPull: true, noEmbed: true, noExtract: true });
    expect(await staleExtractJobs()).toHaveLength(0);
  }, 120_000);

  test('the extract handler consumes { stale: true } jobs via extractStaleFromDB and stamps the pages', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    writeLinkedPages(101);
    git('git add -A && git commit -m "big drop"');
    await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(await stampOf('notes/page-7')).toBeNull();
    expect(await engine.getLinks('notes/page-7')).toHaveLength(0);

    // Run the registered handler exactly as a jobs worker would.
    const { MinionWorker } = await import('../src/core/minions/worker.ts');
    const { registerBuiltinHandlers } = await import('../src/commands/jobs.ts');
    const worker = new MinionWorker(engine, { queue: 'test' });
    await registerBuiltinHandlers(worker, engine);
    const handler = (worker as unknown as { handlers: Map<string, (job: unknown) => Promise<unknown>> })
      .handlers.get('extract');
    expect(handler).toBeDefined();

    const [job] = await staleExtractJobs();
    const result = await handler!({
      id: job.id,
      name: 'extract',
      data: job.data,
      updateProgress: async () => {},
      signal: { aborted: false },
    }) as { stale: boolean; pagesProcessed: number; staleRemaining: number };

    // Behavioral discrimination vs master: master's handler ignores
    // { stale: true } and dir-walks instead — it never stamps the watermark
    // and returns a runExtractCore shape without `stale`.
    expect(result.stale).toBe(true);
    expect(result.pagesProcessed).toBeGreaterThanOrEqual(101);
    expect(result.staleRemaining).toBe(0);

    // The deferred work actually converged: links exist + watermark stamped.
    const links = await engine.getLinks('notes/page-7');
    expect(links.some(l => l.to_slug === 'people/alice')).toBe(true);
    expect(await stampOf('notes/page-7')).not.toBeNull();
  }, 180_000);
});
