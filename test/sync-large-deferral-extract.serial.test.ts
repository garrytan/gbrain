/**
 * #2849 — large-sync extract deferral queues an `extract --stale` follow-up.
 *
 * performSync's incremental path skips inline link/timeline extraction when
 * totalChanges > 100 (the #1794 large-sync deferral), leaving
 * links_extracted_at unstamped. Pre-fix, a standalone sync job (webhook push,
 * `gbrain sync trigger`) had NOTHING behind it to sweep those pages — the
 * autopilot cycle's extract phase only walks that cycle's changedSlugs — so a
 * large webhook push left extraction permanently stale until a manual
 * `gbrain extract --stale`.
 *
 * Pins:
 *   (a) performSync surfaces `extractDeferred: true` on the >100 branch and
 *       leaves the pages unstamped/unlinked.
 *   (b) the `sync` job handler queues an `extract` job with
 *       { stale: true, sourceId? } when extractDeferred is set.
 *   (c) the `extract` handler's stale mode actually sweeps: links created +
 *       watermark stamped (end-to-end recovery, no manual step).
 *
 * Marked .serial.test.ts — spawns git subprocesses + shares one PGLite engine.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';

let engine: PGLiteEngine;
let worker: MinionWorker;
let repoPath: string;

function git(cmd: string): void { execSync(cmd, { cwd: repoPath, stdio: 'pipe' }); }

describe('#2849 — large sync defers extract and queues a stale sweep', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    worker = new MinionWorker(engine, { queue: 'test' });
    await registerBuiltinHandlers(worker, engine, { quiet: true });

    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-large-defer-'));
    git('git init');
    git('git config user.email "t@t.com"');
    git('git config user.name "T"');
    mkdirSync(join(repoPath, 'people'), { recursive: true });
    mkdirSync(join(repoPath, 'notes'), { recursive: true });
    writeFileSync(join(repoPath, 'people/alice.md'), [
      '---', 'type: person', 'title: Alice', '---', '', 'Alice is a founder.',
    ].join('\n'));
    git('git add -A && git commit -m "initial"');

    // Seed: full first sync imports the anchor page + sets last_commit.
    const { performSync } = await import('../src/commands/sync.ts');
    await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });

    // Second commit: 101 new pages → incremental totalChanges > 100.
    for (let i = 0; i < 101; i++) {
      writeFileSync(join(repoPath, `notes/n${i}.md`), [
        '---', 'type: note', `title: Note ${i}`, '---', '',
        `[Alice](people/alice) appears in note ${i}.`,
      ].join('\n'));
    }
    git('git add -A && git commit -m "add 101 pages"');
  }, 120_000);

  afterAll(async () => {
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
    if (engine) await engine.disconnect();
  }, 60_000);

  test('sync handler defers inline extract and queues extract{stale} follow-up; stale sweep recovers', async () => {
    const syncHandler = (worker as unknown as { handlers: Map<string, (job: unknown) => Promise<unknown>> })
      .handlers.get('sync');
    expect(syncHandler).toBeDefined();

    // Same payload shape the webhook submits (minus embed backfill noise).
    const result = await syncHandler!({
      data: { repoPath, noExtract: false, noPull: true, auto_embed_backfill: false },
      signal: { aborted: false },
      updateProgress: async () => {},
    }) as { status: string; extractDeferred?: boolean; extract_stale_job_id?: number | null };

    expect(result.status).toBe('synced');
    // (a) inline extract was deferred, pages left stale.
    expect(result.extractDeferred).toBe(true);
    const staleBefore = await engine.countStalePagesForExtraction();
    expect(staleBefore).toBeGreaterThan(100);
    expect(await engine.getLinks('notes/n0')).toHaveLength(0);

    // (b) a follow-up extract job with stale:true was queued.
    expect(result.extract_stale_job_id).toBeGreaterThan(0);
    const queue = new MinionQueue(engine);
    const extractJobs = await queue.getJobs({ name: 'extract', limit: 5 });
    expect(extractJobs.length).toBe(1);
    expect((extractJobs[0].data as { stale: boolean }).stale).toBe(true);

    // (c) running the extract handler's stale mode recovers: links + stamps.
    const extractHandler = (worker as unknown as { handlers: Map<string, (job: unknown) => Promise<unknown>> })
      .handlers.get('extract');
    await extractHandler!({
      data: extractJobs[0].data,
      signal: { aborted: false },
      updateProgress: async () => {},
    });
    const links = await engine.getLinks('notes/n0');
    expect(links.some(l => l.to_slug === 'people/alice')).toBe(true);
    const rows = await engine.executeRaw<{ links_extracted_at: string | null }>(
      `SELECT links_extracted_at FROM pages WHERE slug = 'notes/n0'`,
    );
    expect(rows[0]?.links_extracted_at).not.toBeNull();
  }, 180_000);

  test('sub-threshold sync does NOT set extractDeferred (no spurious follow-up)', async () => {
    // One more small commit → inline extract path, no deferral.
    writeFileSync(join(repoPath, 'notes/small.md'), [
      '---', 'type: note', 'title: Small', '---', '', 'No big deal.',
    ].join('\n'));
    git('git add -A && git commit -m "one small page"');
    const { performSync } = await import('../src/commands/sync.ts');
    const result = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(result.status).toBe('synced');
    expect(result.extractDeferred).toBeFalsy();
  }, 60_000);
});
