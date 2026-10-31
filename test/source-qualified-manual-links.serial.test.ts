/**
 * Protects independent origin write authority and explicit target read identity.
 * Regresses if manual links scope both endpoints to the writer's source.
 * Existing same-source fence tests do not cover qualified references; no new seam.
 * Synthetic fixtures, in-process PGLite, no providers or external services.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(() => { engine = new PGLiteEngine(); });
afterAll(async () => { await engine.disconnect(); });

test('qualified manual links select the readable target independently of the writable origin', async () => {
  const home = mkdtempSync(join(tmpdir(), 'qualified-links-'));
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await engine.connect({});
      await engine.initSchema();
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      for (const source of ['origin', 'target', 'hidden']) {
        await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [source]);
        for (const slug of ['start', 'end']) await engine.putPage(slug, {
          type: 'note', title: slug, compiled_truth: 'Synthetic fixture.', timeline: '', frontmatter: {},
        }, { sourceId: source });
      }
      const ctx: OperationContext = { engine, sourceId: 'origin', remote: true, config: { engine: 'pglite' }, dryRun: false,
        logger: { info() {}, warn() {}, error() {} },
        auth: { token: 'synthetic', clientId: 'synthetic', sourceId: 'origin', scopes: ['read', 'write'], allowedSources: ['origin', 'target'] } };
      const call = (name: string, p: Record<string, unknown>, context = ctx) => operationsByName[name].handler(context, p);
      const edges = () => engine.executeRaw<{ source_id: string }>(
        'SELECT t.source_id FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.source_id=$1 AND f.slug=$2 ORDER BY t.source_id', ['origin', 'start']);
      const before = await engine.readPageSnapshot('end', { sourceId: 'target' });
      await call('add_link', { from: 'start', to: 'target:end' });
      expect(await edges()).toEqual([{ source_id: 'target' }]);
      expect(await engine.readPageSnapshot('end', { sourceId: 'target' })).toEqual(before);
      await expect(call('add_link', { from: 'start', to: 'hidden:end' })).rejects.toMatchObject({ code: 'permission_denied' });
      await expect(call('add_link', { from: 'start', to: 'target:missing' })).rejects.toMatchObject({ code: 'page_not_found' });
      await expect(call('add_link', { from: 'start', to: 'target:end:extra' })).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(call('add_link', { from: 'start', to: 'target:end' }, {
        ...ctx, auth: { ...ctx.auth!, boundSlugPrefixes: ['other/'] },
      })).rejects.toMatchObject({ code: 'permission_denied' });
      expect(await edges()).toEqual([{ source_id: 'target' }]);
      expect(await call('remove_link', { from: 'start', to: 'target:end' })).toEqual({ status: 'ok', removed: 1 });
      expect(await edges()).toEqual([]);

      await call('add_link', { from: 'start', to: 'origin:end' });
      expect(await edges()).toEqual([{ source_id: 'origin' }]);
      expect(await call('remove_link', { from: 'start', to: 'origin:end' })).toEqual({ status: 'ok', removed: 1 });

      await expect(call('add_link', { from: 'start', to: 'target:end' }, {
        ...ctx, sourceId: 'target',
      })).rejects.toMatchObject({ code: 'not_found' });
      await engine.putPage('private-end', { type: 'note', title: 'Private fixture', compiled_truth: 'Private.', timeline: '',
        frontmatter: { visibility: 'private' } }, { sourceId: 'target' });
      await expect(call('add_link', { from: 'start', to: 'target:private-end' })).rejects.toMatchObject({ code: 'page_not_found' });
      await engine.putPage('foreign-only', { type: 'note', title: 'Foreign fixture', compiled_truth: 'Foreign.', timeline: '', frontmatter: {} }, { sourceId: 'target' });
      await expect(call('add_link', { from: 'start', to: 'foreign-only' })).rejects.toMatchObject({ code: 'permission_denied' });

      // Change real database state after preflight and before the transaction.
      // Intercepting the existing transaction method adds no production seam.
      for (const boundary of ['revision', 'incarnation'] as const) {
        const racing = new Proxy(engine, { get(target, key) {
          if (key === 'transaction') return async (...args: Parameters<typeof engine.transaction>) => {
            if (boundary === 'revision') await target.executeRaw('UPDATE pages SET compiled_truth=$1 WHERE source_id=$2 AND slug=$3', ['Changed fixture.', 'target', 'end']);
            else {
              await target.executeRaw('DELETE FROM sources WHERE id=$1', ['target']);
              await target.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', ['target']);
              await target.putPage('end', { type: 'note', title: 'end', compiled_truth: 'Recreated fixture.', timeline: '', frontmatter: {} }, { sourceId: 'target' });
            }
            return target.transaction(...args);
          };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
        await expect(call('add_link', { from: 'start', to: 'target:end' }, { ...ctx, engine: racing }))
          .rejects.toMatchObject({ code: boundary === 'revision' ? 'revision_conflict' : 'source_changed' });
        expect(await edges()).toEqual([]);
      }
      const managedBefore = await engine.readPageSnapshot('end', { sourceId: 'target' });

      // Managed database-only edges use origin authority, never a target write grant.
      // The local caller has real durable authority initialized by the coordinator.
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const local = { ...ctx, remote: false, auth: undefined };
      await call('add_link', { from: 'start', to: 'target:end', link_type: 'works_at', valid_from: '2025-01-01' }, local);
      expect(await edges()).toEqual([{ source_id: 'target' }]);
      expect(await engine.executeRaw('SELECT source_id FROM link_transitions WHERE producer=$1', ['manual'])).toEqual([{ source_id: 'origin' }]);
      expect(await call('remove_link', { from: 'start', to: 'target:end' }, local)).toEqual({ status: 'ok', removed: 1 });
      expect(await engine.executeRaw('SELECT id FROM link_transitions WHERE producer=$1', ['manual'])).toEqual([]);
      expect(await engine.readPageSnapshot('end', { sourceId: 'target' })).toEqual(managedBefore);
      const tokenId = crypto.randomUUID();
      await engine.executeRaw(`INSERT INTO access_tokens(id,name,token_hash,scopes,source_grant,source_id,federated_read,permissions)
        VALUES($1,'synthetic',$2,ARRAY['read','write'],'federated','origin',ARRAY['origin','target'],
          '{"source_id":["origin","target"]}'::jsonb)`, [tokenId, tokenId]);
      const remote = { ...ctx, auth: { ...ctx.auth!, principal: { kind: 'legacy_token' as const, id: tokenId } } };
      await call('add_link', { from: 'start', to: 'target:end' }, remote);
      expect(await edges()).toEqual([{ source_id: 'target' }]);
      expect(await call('remove_link', { from: 'start', to: 'target:end' }, remote)).toEqual({ status: 'ok', removed: 1 });
      await engine.executeRaw('UPDATE access_tokens SET revoked_at=now() WHERE id=$1', [tokenId]);
      await expect(call('add_link', { from: 'start', to: 'target:end' }, remote)).rejects.toMatchObject({ code: 'permission_denied' });
      expect(await edges()).toEqual([]);
    });
  } finally {
    await disposePersistenceConsumer(engine);
    rmSync(home, { recursive: true, force: true });
  }
}, 120_000);
