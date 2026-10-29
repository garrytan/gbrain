/**
 * Ordinary writes while segmented storage is off (Wave B PR 2, fix lane E).
 *
 * 1. Protects: "while pages.segmented_storage is off nothing user-visible changes" for a non-owner write role
 *    (LOGIN, NOBYPASSRLS) holding every grant except the six segment tables, on a brain with no segmented page.
 *    put_page (create, update and an unchanged re-put), remember, a managed sync import (first, update, unchanged) and
 *    the embedding effects they queue run for it as before, and a full resync of unchanged files is waived by the no-op
 *    kernel as for the owner. docs/ENGINES.md names the
 *    maintenance paths that do need the grants.
 * 2. Fails when: an ordinary write path names a segment table although the role can see no segmented chunk row,
 *    so Postgres refuses it with 42501: the embedding effect then never embeds the page (it retries effect_unavailable)
 *    and the no-op kernel's page read fails, so unchanged files are re-admitted instead of waived.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GBrainConfig } from '../../src/core/config.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';
import { SYNC_IMPORT_PROVENANCE_OP } from '../../src/core/persistence/sync-holds.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { makeGitFixture } from '../helpers/git-fixture.ts';
import { withEnv } from '../helpers/with-env.ts';
import { LEGACY_EMBEDDING_CONFIG } from '../helpers/legacy-embedding-config.ts';
import { hasDatabase, setupLegacyEmbeddingDB, teardownDB } from './helpers.ts';

const WRITER = 'gbrain_seg_off_writer_' + randomUUID().replaceAll('-', '').slice(0, 12);
const SEGMENT_TABLES = ['page_body_manifest', 'page_body_staging_parts', 'page_body_staging_texts', 'page_body_stagings', 'page_segment_texts', 'page_view_digests'];

/**
 * A full episode admits an already-current page in place (sync-classify.ts `inPlace`), so unchanged files reach the
 * waiver only while a reparse is owed: here their import records name an older parser, as after a parser upgrade.
 */
const olderParserRecords = (engine: BrainEngine, sourceId: string) => engine.executeRaw(
  `UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,parser,parser_version}','"an-older-parser"'::jsonb) WHERE op=$1 AND starts_with(fingerprint, $2 || ':')`,
  [SYNC_IMPORT_PROVENANCE_OP, sourceId]);

(hasDatabase() ? describe : describe.skip)('ordinary writes while segmented storage is off (non-owner write role)', () => {
  let engine: PostgresEngine;
  let writer: PostgresEngine;
  let granted: string[] = [];
  const home = mkdtempSync(join(tmpdir(), 'gbrain-seg-off-writer-'));
  const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_BACKUP_CHECK: 'off', GBRAIN_SYNC_NO_EXTRACT_NUDGE: '1' };
  const config = { engine: 'postgres', embedding_disabled: false } as unknown as GBrainConfig;
  const ctx = (): OperationContext => ({ engine: writer, config, logger: { info() {}, warn() {}, error() {} },
    dryRun: false, remote: false, sourceId: 'default' }) as unknown as OperationContext;
  const run = (name: string, params: Record<string, unknown>) => operations.find(o => o.name === name)!.handler(ctx(), params) as Promise<Record<string, unknown>>;
  const outcome = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; message?: string }) => 'error ' + (e.code ?? '') + ' ' + String(e.message).slice(0, 120));

  beforeAll(async () => {
    engine = await setupLegacyEmbeddingDB();
    configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: { OPENAI_API_KEY: 'sk-test' } });
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ values, warnings: [], embeddings: values.map(() => Array(1536).fill(0.1)), usage: { tokens: values.length } })) as never);
    const password = randomUUID();
    await engine.executeRaw('CREATE ROLE ' + WRITER + " LOGIN PASSWORD '" + password + "' NOSUPERUSER NOBYPASSRLS");
    await engine.executeRaw('GRANT USAGE ON SCHEMA public TO ' + WRITER);
    granted = (await engine.executeRaw<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).map(r => r.t).filter(t => !SEGMENT_TABLES.includes(t));
    await engine.executeRaw('GRANT ALL ON ' + granted.join(', ') + ' TO ' + WRITER);
    await engine.executeRaw('GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ' + WRITER);
    for (const t of granted) await engine.executeRaw('CREATE POLICY ' + WRITER + '_all ON ' + t + ' FOR ALL TO ' + WRITER + ' USING (true) WITH CHECK (true)');
    await engine.executeRaw('ALTER ROLE ' + WRITER + " SET app.scopes = '*'");
    const url = new URL(process.env.DATABASE_URL!);
    url.username = WRITER;
    url.password = password;
    writer = new PostgresEngine();
    await writer.connect({ database_url: url.toString(), poolSize: 4 });
  }, 300_000);

  afterAll(async () => {
    __setEmbedTransportForTests(null);
    resetGateway();
    if (writer) { await disposePersistenceConsumer(writer); await writer.disconnect(); }
    if (engine) {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      for (const t of granted) await engine.executeRaw('DROP POLICY IF EXISTS ' + WRITER + '_all ON ' + t);
      await engine.executeRaw('DROP OWNED BY ' + WRITER).catch(() => undefined);
      await engine.executeRaw('DROP ROLE IF EXISTS ' + WRITER);
    }
    await teardownDB();
    rmSync(home, { recursive: true, force: true });
  });

  test('put_page, remember, a managed sync import and their embedding effects run without the segment grants', async () => withEnv(env, async () => {
    expect(await engine.getConfig('pages.segmented_storage')).toBeNull();
    expect(await writer.executeRaw("SELECT current_user AS role, has_table_privilege('page_body_manifest', 'SELECT') AS manifest")).toEqual([{ role: WRITER, manifest: false }]);
    const slug = 'notes/writer-ledger';
    const body = (text: string) => '---\ntype: note\ntitle: Writer ledger\n---\n# Writer ledger\n\n' + text + '\n';
    const revision = async () => String((await run('get_page', { slug, include_content: true })).revision);
    const seen: Record<string, string> = {};
    seen.create = await outcome(run('put_page', { slug, content: body('first'), request_id: randomUUID() }));
    seen.update = await outcome((async () => run('put_page', { slug, content: body('second'), expected_revision: await revision(), request_id: randomUUID() }))());
    seen.unchanged = await outcome((async () => run('put_page', { slug, content: body('second'), expected_revision: await revision(), request_id: randomUUID() }))());
    seen.remember = await outcome(run('remember', { fact: 'Alice Example prefers tea', entity: 'people/alice-example', provenance: 'synthetic test note' }));

    const id = 'sync-' + randomUUID().replaceAll('-', '').slice(0, 16);
    const root = join(home, id);
    mkdirSync(root);
    await makeGitFixture(root);
    const commit = () => { execFileSync('git', ['-C', root, 'add', '.']); execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']); };
    writeFileSync(join(root, 'a.md'), '# A\n\nFirst observation.\n');
    commit();
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
    await claimWorktree(engine, id, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const options = { sourceId: id, noPull: true, noEmbed: true, noExtract: true };
    seen.sync_first = await outcome(performManagedSync(writer, options));
    writeFileSync(join(root, 'a.md'), '# A\n\nUpdated observation.\n');
    writeFileSync(join(root, 'b.md'), '# B\n\nSecond page.\n');
    commit();
    seen.sync_update = await outcome(performManagedSync(writer, options));
    seen.sync_noop = await outcome(performManagedSync(writer, options));
    const revs = async () => JSON.stringify(await engine.executeRaw("SELECT slug, knowledge_revision::text AS r FROM pages WHERE source_id=$1 ORDER BY slug", [id]));
    const before = await revs();
    // A full resync of unchanged files whose records name an older parser runs the no-op kernel, which waives both instead of re-admitting them.
    await olderParserRecords(engine, id);
    const full = await performManagedSync(writer, { ...options, full: true });

    // The embedding effects the writes queued run as the write role, as its own persistence consumer would.
    await disposePersistenceConsumer(writer);
    for (let i = 0; i < 5; i++) if (!await runPersistenceEffects(writer, config, { hostId: localHostId(), limit: 32 })) break;
    const effects = await engine.executeRaw<{ state: string; reason: string | null }>("SELECT e.state, e.error_code AS reason FROM persistence_effects e JOIN persistence_requests r ON r.id = e.request_id WHERE e.kind = 'embedding' AND r.slug = $1", [slug]);

    expect(seen).toEqual({ create: 'ok', update: 'ok', unchanged: 'ok', remember: 'ok', sync_first: 'ok', sync_update: 'ok', sync_noop: 'ok' });
    const unembedded = (await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE p.slug = $1 AND cc.embedding IS NULL", [slug]))[0]!.n;
    expect({ fullResync: { status: full.status, waived: full.waived, revisionsKept: (await revs()) === before },
      embedding: { effects: effects.length > 0, notCommitted: effects.filter(e => e.state !== 'committed'), unembedded } })
      .toEqual({ fullResync: { status: 'synced', waived: { imports: 2, deletes: 0 }, revisionsKept: true },
        embedding: { effects: true, notCommitted: [], unembedded: 0 } });
    expect(await engine.executeRaw<{ slug: string; body: string }>("SELECT slug, compiled_truth AS body FROM pages WHERE source_id = $1 ORDER BY slug", [id]))
      .toEqual([{ slug: 'a', body: expect.stringContaining('Updated observation.') }, { slug: 'b', body: expect.stringContaining('Second page.') }]);
    expect(await engine.executeRaw("SELECT count(*)::int AS n FROM pages WHERE body_storage = 'segmented'")).toEqual([{ n: 0 }]);
  }), 300_000);
});
