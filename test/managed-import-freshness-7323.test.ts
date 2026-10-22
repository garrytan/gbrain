/**
 * #7323: committed imports of a whole registered non-Git root advance freshness through the owner.
 * Real runImport -> canonical publication -> source status on both engines; partial and non-owner
 * observations must not mask stale sources. Existing #1691 tests cover the classic path.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runImport } from '../src/commands/import.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-import-freshness-'));
const env = { GBRAIN_HOME: home };
const old = '2020-01-01T00:00:00.000Z';
afterAll(() => rmSync(home, { recursive: true, force: true }));

for (const kind of testBackends()) {
  describe(`managed non-Git import freshness (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await withEnv(env, async () => { await disposePersistenceConsumer(engine); await close(); }); });

    async function fixture(config: Record<string, unknown> = {}) {
      await disposePersistenceConsumer(engine);
      const sourceId = `import-${randomUUID().slice(0, 8)}`;
      const root = join(home, sourceId);
      mkdirSync(root);
      writeFileSync(join(root, 'seed.md'), '---\ntitle: Seed\n---\nA source-specific seed note.\n');
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path,config,last_sync_at) VALUES($1,$1,$2,$3::text::jsonb,$4::timestamptz)',
        [sourceId, root, JSON.stringify(config), old]);
      await registerLocalWriter(engine, 'cli');
      await claimWorktree(engine, sourceId, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      return { sourceId, root };
    }
    const stamp = async (sourceId: string) => {
      const [row] = await engine.executeRaw<{ last_sync_at: string | Date; last_commit: string | null }>('SELECT last_sync_at,last_commit FROM sources WHERE id=$1', [sourceId]);
      return { at: new Date(row!.last_sync_at).toISOString(), commit: row!.last_commit };
    };
    const run = (f: { sourceId: string; root: string }, extra: Parameters<typeof runImport>[2] = {}) =>
      runImport(engine, [f.root, '--source', f.sourceId, '--no-embed', '--json'], extra);

    test('changed and unchanged clean runs advance freshness only after actual page publication', () => withEnv(env, async () => {
      const f = await fixture();
      const first = await run(f);
      expect(first.failures).toEqual([]);
      expect((await engine.getPage('seed', { sourceId: f.sourceId }))?.compiled_truth).toContain('source-specific seed');
      const initial = await stamp(f.sourceId);
      expect(initial.at).not.toBe(old);
      expect(initial.commit).toBeNull();
      const second = await run(f);
      expect(second.imported).toBe(0);
      expect(second.failures).toEqual([]);
      expect(new Date((await stamp(f.sourceId)).at).getTime()).toBeGreaterThan(new Date(initial.at).getTime());
    }), 120_000);

    test('malformed exclusions prevent freshness despite healthy sibling publication', () => withEnv(env, async () => {
      const f = await fixture();
      writeFileSync(join(f.root, 'bad[name].md'), '# Malformed path\n');
      await run(f);
      expect(await engine.getPage('seed', { sourceId: f.sourceId })).not.toBeNull();
      expect((await stamp(f.sourceId)).at).toBe(old);
    }), 120_000);

    test('held files prevent a clean-looking run from advancing freshness', () => withEnv(env, async () => {
      const f = await fixture();
      const result = await run(f, { heldPaths: new Set(['seed.md']) });
      expect(result.failures).toEqual([]);
      expect(await engine.getPage('seed', { sourceId: f.sourceId })).toBeNull();
      expect((await stamp(f.sourceId)).at).toBe(old);
    }), 120_000);

    test('a failed file leaves freshness stale while healthy siblings commit', () => withEnv(env, async () => {
      const f = await fixture();
      writeFileSync(join(f.root, 'broken.md'), '---\ntype: [unclosed\n---\nA broken note.\n');
      const result = await run(f);
      expect(result.failures.length).toBeGreaterThan(0);
      expect(await engine.getPage('seed', { sourceId: f.sourceId })).not.toBeNull();
      expect((await stamp(f.sourceId)).at).toBe(old);
    }), 120_000);

    for (const config of [{ kind: 'google' }, { remote_url: 'https://example.invalid/brain.git' }]) {
      test(`${JSON.stringify(config)} keeps freshness owned by its actual sync`, () => withEnv(env, async () => {
        const f = await fixture(config);
        await run(f);
        expect((await stamp(f.sourceId)).at).toBe(old);
      }), 120_000);
    }

    test('Git checkout import does not claim Git-sync freshness', () => withEnv(env, async () => {
      const f = await fixture();
      execFileSync('git', ['init', '-q', f.root]);
      await run(f);
      expect((await stamp(f.sourceId)).at).toBe(old);
    }), 120_000);

    test('single-file and subdirectory imports do not claim whole-root freshness', () => withEnv(env, async () => {
      const f = await fixture();
      await run({ ...f, root: join(f.root, 'seed.md') });
      expect((await stamp(f.sourceId)).at).toBe(old);
      mkdirSync(join(f.root, 'part'));
      writeFileSync(join(f.root, 'part', 'child.md'), '# Child\n\nA partial-root note.\n');
      await run({ ...f, root: join(f.root, 'part') });
      expect((await stamp(f.sourceId)).at).toBe(old);
    }), 120_000);

    test('sync-owned bookmark runs do not race their outer completion gate', () => withEnv(env, async () => {
      const f = await fixture();
      await run(f, { managedBookmark: true });
      expect((await stamp(f.sourceId)).at).toBe(old);
    }), 120_000);
    test('an explicit file exclusion cannot claim whole-root freshness', () => withEnv(env, async () => {
      const f = await fixture();
      await run(f, { exclude: ['seed.md'] });
      expect((await stamp(f.sourceId)).at).toBe(old);
    }), 120_000);

    test('an owner epoch change after page commit fences the completion', () => withEnv(env, async () => {
      const f = await fixture();
      await run(f, { onFileResult: async () => {
        await engine.executeRaw('UPDATE persistence_worktrees SET owner_epoch=owner_epoch+1 WHERE id IN (SELECT worktree_id FROM persistence_source_bindings WHERE source_id=$1)', [f.sourceId]);
        return undefined;
      } });
      expect(await engine.getPage('seed', { sourceId: f.sourceId })).not.toBeNull();
      expect((await stamp(f.sourceId)).at).toBe(old);
    }), 120_000);

    test('a source reconfigured as a connector during import cannot receive its old heartbeat', () => withEnv(env, async () => {
      const f = await fixture();
      await run(f, { onFileResult: async () => {
        await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1', [f.sourceId, JSON.stringify({ kind: 'google' })]);
        return undefined;
      } });
      expect((await stamp(f.sourceId)).at).toBe(old);
    }), 120_000);

    test('caller cancellation after a committed page does not stamp completion', () => withEnv(env, async () => {
      const f = await fixture();
      const abort = new AbortController();
      await expect(run(f, { signal: abort.signal, onFileResult: async () => { abort.abort(new Error('stop import')); return undefined; } })).rejects.toThrow();
      expect(await engine.getPage('seed', { sourceId: f.sourceId })).not.toBeNull();
      expect((await stamp(f.sourceId)).at).toBe(old);
    }), 120_000);

    test('accepted but uncommitted imports keep freshness stale; committed replay advances it', () => withEnv(env, async () => {
      const f = await fixture();
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      installFaultHook(async point => { if (point === 'consumer:claiming') await held; });
      try {
        const result = await run(f);
        expect(result.failures).toEqual([]);
        expect(result.imported).toBe(0);
        expect(await engine.getPage('seed', { sourceId: f.sourceId })).toBeNull();
        expect((await stamp(f.sourceId)).at).toBe(old);
        const pending = await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE source_id=$1', [f.sourceId]);
        expect(pending.length).toBe(1);
        expect(pending[0]!.state).not.toBe('committed');
      } finally {
        installFaultHook(undefined);
        release();
        await disposePersistenceConsumer(engine);
      }
      await run(f);
      expect(await engine.getPage('seed', { sourceId: f.sourceId })).not.toBeNull();
      expect((await stamp(f.sourceId)).at).not.toBe(old);
    }), 120_000);
  });
}
