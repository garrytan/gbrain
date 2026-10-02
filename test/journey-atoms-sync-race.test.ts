/**
 * Cross-lane journey (ENG-O14): #5770 together with #5777, on PGLite and, with
 * a safe DATABASE_URL, Postgres (test/e2e/journey-atoms-sync-race-postgres.test.ts).
 *
 * A managed source page is synced and extracted, edited through sync, caught
 * in the trailing-commit window of a queued publication (#5777: skipped, not a
 * sticky source_changed), re-extracted (#5774 retires the stale atom), deleted
 * and cleaned up by `gbrain repair stale-atoms`, then restored: discovery
 * offers it again and extraction restores every atom of its current text.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ChatResult } from '../src/core/ai/gateway.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { runPhaseExtractAtoms, discoverExtractablePages } from '../src/core/cycle/extract-atoms.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { loadSyncFailures } from '../src/core/sync-failure-ledger.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const note = (text: string) => `---\ntitle: Example note\ntype: source\n---\n${`${text} `.repeat(40).trim()}\n`;

for (const kind of testBackends()) {
  describe(`#5770 with #5777 (${kind})`, () => {
    let engine: BrainEngine;
    let close: (() => Promise<void>) | undefined;
    const home = mkdtempSync(join(tmpdir(), 'gbrain-journey-atoms-sync-'));
    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; }
    }, 120_000);
    afterAll(async () => {
      await withEnv({ GBRAIN_HOME: home }, () => disposePersistenceConsumer(engine));
      if (close) await close(); else await engine.disconnect();
      resetGateway();
      rmSync(home, { recursive: true, force: true });
    });

    test('queued publication, stale-atom preview, source change, retirement, restoration and rediscovery', async () => withEnv({ GBRAIN_HOME: home }, async () => {
      const sourceId = `journey-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const root = join(home, sourceId);
      const slug = 'notes/example';
      const path = join(root, 'notes/example.md');
      const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      const commit = (message: string) => { git('add', 'notes/example.md'); git('-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); return git('rev-parse', 'HEAD'); };
      mkdirSync(join(root, 'notes'), { recursive: true }); git('init', '-q');
      writeFileSync(path, note('The first project record.')); commit('first');
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
      await claimWorktree(engine, sourceId, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const unmanaged = async <T>(fn: () => Promise<T>): Promise<T> => {
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        try { return await fn(); } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
      };
      let titles = ['Patience compounds', 'Hire slowly'];
      let calls = 0;
      const chat = async (): Promise<ChatResult> => {
        calls++;
        return { text: JSON.stringify(titles.map(title => ({ title, atom_type: 'insight', body: `Body for ${title}.` }))),
          blocks: [], stopReason: 'end', usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
      };
      const extract = async () => {
        const page = (await engine.getPage(slug, { sourceId }))!;
        return runPhaseExtractAtoms(engine, { sourceId, _transcripts: [], _pages: [{ slug, content: page.compiled_truth, contentHash: page.content_hash! }], _chat: chat });
      };
      const atoms = async () => Object.fromEntries((await engine.executeRaw<{ slug: string; deleted: boolean; retired_by: string | null }>(
        "SELECT slug, deleted_at IS NOT NULL AS deleted, frontmatter->>'retired_by' AS retired_by FROM pages WHERE source_id=$1 AND type='atom'", [sourceId]))
        .map(row => [row.slug.replace(/^atoms\/[^/]+\//, '').replace(/-[0-9a-f]+$/, ''), { deleted: row.deleted, retired_by: row.retired_by }]));
      const repair = async (args: string[]) => {
        const lines: string[] = [];
        const original = console.log;
        console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
        try { await runRepairCommand(engine, [...args, '--json']); } finally { console.log = original; }
        return JSON.parse(lines.join('\n')).results[0] as { apply_command: string; listing: Array<{ class: string }>; outcomes?: Record<string, number> };
      };
      const failures = () => loadSyncFailures().filter(row => row.source_id === sourceId);

      expect((await performManagedSync(engine, { sourceId, noPull: true })).status).toBe('first_sync');
      expect((await extract()).status).toBe('ok');
      expect(await atoms()).toEqual({ 'patience-compounds': { deleted: false, retired_by: null }, 'hire-slowly': { deleted: false, retired_by: null } });

      writeFileSync(path, note('The edited project record.')); commit('edit');
      expect((await performManagedSync(engine, { sourceId, noPull: true })).status).not.toBe('blocked_by_failures');
      writeFileSync(path, note('An older record a trailing commit still carries.')); const trailing = commit('trailing'); writeFileSync(path, note('The edited project record.'));
      const raced = await performManagedSync(engine, { sourceId, noPull: true });
      expect(raced.status).not.toBe('blocked_by_failures');
      expect(raced.managedWrite).toBeUndefined();
      expect(raced.toCommit).toBe(trailing);
      expect(failures()).toEqual([]);
      expect((await engine.getPage(slug, { sourceId }))?.compiled_truth).toContain('The edited project record.');

      titles = ['Patience compounds over years', 'Hire slowly'];
      expect((await extract()).status).toBe('ok');
      expect(await atoms()).toMatchObject({ 'patience-compounds': { deleted: true, retired_by: 'managed-reextract' },
        'patience-compounds-over-years': { deleted: false }, 'hire-slowly': { deleted: false } });

      await unmanaged(() => engine.softDeletePage(slug, { sourceId }));
      const preview = await repair(['stale-atoms', '--source', sourceId]);
      expect(preview.listing.map(entry => entry.class)).toEqual(['origin_gone', 'origin_gone']);
      expect(preview.apply_command).toMatch(/^gbrain repair stale-atoms --source \S+ --apply --expect [0-9a-f]{64}$/);
      expect((await repair(preview.apply_command.split(' ').slice(2))).outcomes).toEqual({ retired: 2 });
      expect(await atoms()).toMatchObject({ 'patience-compounds-over-years': { deleted: true, retired_by: 'stale-atoms' },
        'hire-slowly': { deleted: true, retired_by: 'stale-atoms' } });

      await unmanaged(() => engine.restorePage(slug, { sourceId }));
      expect((await discoverExtractablePages(engine, sourceId)).map(item => item.slug)).toEqual([slug]);
      titles = ['Patience compounds', 'Hire slowly'];
      expect((await extract()).status).toBe('ok');
      expect(calls).toBe(3);
      expect(await atoms()).toEqual({ 'patience-compounds': { deleted: false, retired_by: null }, 'hire-slowly': { deleted: false, retired_by: null },
        'patience-compounds-over-years': { deleted: true, retired_by: 'stale-atoms' } });
      expect(await discoverExtractablePages(engine, sourceId)).toEqual([]);
      expect((await performManagedSync(engine, { sourceId, noPull: true })).status).not.toBe('blocked_by_failures');
      expect(failures()).toEqual([]);
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    }), 120_000);
  });
}
