/**
 * Remote fact writes follow the same page-visibility policy as remote fact
 * reads (#4352 class). A `visibility = 'world'` fact whose provenance page
 * (`source_markdown_slug`) is `visibility: private` is invisible to an
 * untrusted caller, so a remote `forget` of it answers not_found and writes
 * nothing (no withdrawal, no owner proposal), `remember.replaces` cannot name
 * it, `remember`'s duplicate checks never match it, and `forget`'s
 * similar_active candidates never list it. The trusted local CLI is unchanged.
 *
 * Both engines: PGLite always, Postgres through
 * test/e2e/remote-fact-write-private-provenance-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { registerLocalWriter, readLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { Principal } from '../src/core/persistence/model.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { decideSingleFact } from '../src/core/facts/single-prepare.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;
const ENTITY = 'people/alice-example';
const SECRET_PAGE = 'meetings/secret-sync';
const quiet = { info() {}, warn() {}, error() {} };

for (const kind of testBackends()) {
  describe(`remote fact writes skip private-provenance facts (${kind})`, () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-write-visibility-'));
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let sourceId = '';
    let remote: OperationContext;
    let local: OperationContext;

    const run = (ctx: OperationContext, op: string, params: R) =>
      withEnv({ GBRAIN_HOME: home }, () => operationsByName[op].handler(ctx, { request_id: randomUUID(), ...params }) as Promise<R>);
    const factRow = async (id: number) => (await engine.executeRaw<{ expired_at: unknown; superseded_by: unknown }>(
      'SELECT expired_at, superseded_by FROM facts WHERE id = $1', [id]))[0]!;
    const withdrawals = async () => Number((await engine.executeRaw<{ n: number | string }>(
      'SELECT COUNT(*) AS n FROM fact_withdrawals WHERE source_id = $1', [sourceId]))[0]!.n);
    const proposals = async () => Number((await engine.executeRaw<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM trust_proposals`))[0]!.n);
    const factCount = async () => Number((await engine.executeRaw<{ n: number | string }>(
      'SELECT COUNT(*) AS n FROM facts WHERE source_id = $1', [sourceId]))[0]!.n);

    /** A world fact about ENTITY whose provenance page is the private meeting. */
    async function hiddenFact(text: string, tier = 'agent_written'): Promise<number> {
      const [row] = await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw<{ id: number | string }>(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_markdown_slug, trust_tier)
         VALUES ($1, $2, $3, 'fact', 'world', 'test', $4, $5) RETURNING id`, [sourceId, ENTITY, text, SECRET_PAGE, tier]), TEST_WRITE_ATTRIBUTION));
      return Number(row!.id);
    }
    async function visibleFact(text: string): Promise<number> {
      return Number((await run(local, 'remember', { fact: text, provenance: 'owner', entity: ENTITY, visibility: 'world' })).id);
    }
    async function sameEmbedding(ids: number[]): Promise<void> {
      const [col] = await engine.executeRaw<{ t: string }>(
        `SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'facts'::regclass AND attname = 'embedding'`);
      const dims = Number(/\((\d+)\)/.exec(col!.t)![1]);
      const literal = `[${Array.from({ length: dims }, (_, i) => (i % 7) / 10).join(',')}]`;
      await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw(
        `UPDATE facts SET embedding = $1::text::${col!.t.replace(/\(.*$/, '')}, embedding_model = 'test-model' WHERE id = ANY($2::bigint[])`,
        [literal, ids]), TEST_WRITE_ATTRIBUTION));
    }

    beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
      configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      sourceId = `wv-${randomUUID().slice(0, 8)}`;
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      await registerLocalWriter(engine, 'cli');
      const minted = await mintLegacyToken(engine, { name: `token-${sourceId}`, scopes: ['read', 'write'], sourceGrant: [sourceId], takesHolders: ['world'] });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      await readLocalWriter(engine, 'cli');
      const base = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId, dryRun: false, logger: quiet };
      remote = { ...base, remote: true, transport: 'http', takesHoldersAllowList: ['world'],
        auth: { token: '', clientId: minted.id, principal: { kind: 'legacy_token', id: minted.id } as Principal, sourceId, allowedSources: [sourceId], scopes: ['read', 'write'] } } as unknown as OperationContext;
      local = { ...base, remote: false } as unknown as OperationContext;
      await run(local, 'put_page', { slug: ENTITY, content: '---\ntype: person\ntitle: Alice Example\n---\nAlice is a founder.\n' });
      await run(local, 'put_page', { slug: SECRET_PAGE, content: '---\ntype: meeting\ntitle: secret sync\nvisibility: private\n---\nA private meeting.\n' });
      __resetPrivateVisibilityCacheForTests();
    }), 180_000);
    afterAll(async () => {
      resetGateway();
      await disposePersistenceConsumer(engine);
      await close?.();
      rmSync(home, { recursive: true, force: true });
    });

    test('remote forget of a private-provenance world fact is not_found and writes nothing; a visible fact still forgets', async () => {
      const hidden = await hiddenFact('SECRETPROV-alpha ships the launch');
      const before = { withdrawals: await withdrawals(), proposals: await proposals() };
      await expect(run(remote, 'forget', { id: String(hidden) })).rejects.toMatchObject({ code: 'not_found' });
      expect(await factRow(hidden)).toMatchObject({ expired_at: null });
      expect(await withdrawals()).toBe(before.withdrawals);
      expect(await proposals()).toBe(before.proposals);

      const visible = await visibleFact('OPENPROV-beta reviews the plan');
      expect((await run(remote, 'forget', { id: String(visible) })).expired).toBe(true);
      expect((await factRow(visible)).expired_at).not.toBeNull();
    }, 90_000);

    test('remote forget of a confirmed private-provenance fact files no owner proposal', async () => {
      const hidden = await hiddenFact('SECRETPROV-gamma owns the budget', 'user_confirmed');
      const before = await proposals();
      await expect(run(remote, 'forget', { id: String(hidden) })).rejects.toMatchObject({ code: 'not_found' });
      expect(await proposals()).toBe(before);
      expect(await factRow(hidden)).toMatchObject({ expired_at: null });
    }, 90_000);

    test('local forget of a private-provenance world fact is unchanged', async () => {
      const hidden = await hiddenFact('SECRETPROV-delta hires a lead');
      expect((await run(local, 'forget', { id: String(hidden) })).expired).toBe(true);
      expect((await factRow(hidden)).expired_at).not.toBeNull();
    }, 90_000);

    test('remote remember.replaces cannot name a private-provenance fact', async () => {
      const hidden = await hiddenFact('SECRETPROV-epsilon leads sales');
      const count = await factCount();
      const attempt = run(remote, 'remember', { fact: 'OPENPROV-zeta leads marketing', provenance: 'web page', entity: ENTITY, replaces: String(hidden) });
      await expect(attempt).rejects.toMatchObject({ code: 'not_found' });
      await attempt.catch((error: Error) => expect(JSON.stringify({ ...error, message: error.message })).not.toContain(SECRET_PAGE));
      expect(await factCount()).toBe(count);
      expect(await factRow(hidden)).toMatchObject({ expired_at: null, superseded_by: null });
    }, 90_000);

    test('remote remember of a private-provenance claim never reports it as already known; local still does', async () => {
      const claim = 'SECRETPROV-lambda buys the company';
      const hidden = await hiddenFact(claim);
      const remoteWrite = await run(remote, 'remember', { fact: claim, provenance: 'web page', entity: ENTITY });
      expect(Number(remoteWrite.id)).not.toBe(hidden);
      expect(JSON.stringify(remoteWrite)).not.toContain(`#${hidden}`);
      const localWrite = await run(local, 'remember', { fact: 'SECRETPROV-mu sells the company', provenance: 'owner', entity: ENTITY });
      const localDup = await run(local, 'remember', { fact: 'SECRETPROV-mu sells the company', provenance: 'owner', entity: ENTITY });
      expect(localDup).toMatchObject({ status: 'duplicate', id: String(localWrite.id) });
      const hiddenLocal = await hiddenFact('SECRETPROV-nu merges the teams');
      expect(await run(local, 'remember', { fact: 'SECRETPROV-nu merges the teams', provenance: 'owner', entity: ENTITY }))
        .toMatchObject({ status: 'duplicate', id: String(hiddenLocal) });
    }, 90_000);

    test('a remote near-duplicate check never matches a fact on a private page; local still does', async () => {
      const page = 'people/carol-example';
      await run(local, 'put_page', { slug: page, content: '---\ntype: person\ntitle: Carol Example\nvisibility: private\n---\nCarol is private.\n' });
      __resetPrivateVisibilityCacheForTests();
      const [row] = await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw<{ id: number | string }>(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_markdown_slug, trust_tier)
         VALUES ($1, $2, 'SECRETPROV-xi opens a second office', 'fact', 'world', 'test', $2, 'agent_written') RETURNING id`, [sourceId, page]), TEST_WRITE_ATTRIBUTION));
      const hidden = Number(row!.id);
      await sameEmbedding([hidden]);
      await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw(
        'UPDATE facts SET embedded_text_hash = md5(fact) WHERE id = $1', [hidden]), TEST_WRITE_ATTRIBUTION));
      const [col] = await engine.executeRaw<{ t: string }>(
        `SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'facts'::regclass AND attname = 'embedding'`);
      const dims = Number(/\((\d+)\)/.exec(col!.t)![1]);
      const embedding = Float32Array.from({ length: dims }, (_, i) => (i % 7) / 10);
      const input = { entity_slug: page, fact: 'SECRETPROV-xi is opening another office', kind: 'fact' as const, visibility: 'world' as const };
      const decide = (excludePrivate: boolean) => decideSingleFact(engine, sourceId, input, embedding, 'test-model', 'owner', { excludePrivate });
      // Cosine supersession needs a threshold for the embedding model (supersession-threshold.ts); test-model has none.
      await engine.setConfig('facts.supersession_thresholds', JSON.stringify({ [`test-model@${dims}`]: 0.95 }));
      try {
        expect((await decide(false)).candidate?.id).toBe(hidden);
        expect(await decide(true)).toEqual({ status: 'inserted', candidate: null });
      } finally { await engine.unsetConfig('facts.supersession_thresholds'); }
    }, 90_000);

    test('similar_active after a remote forget never lists a private-provenance fact; local still does', async () => {
      const anchorRemote = await visibleFact('OPENPROV-eta closes the round');
      const hiddenTwin = await hiddenFact('SECRETPROV-theta closes the round early');
      const visibleTwin = await visibleFact('OPENPROV-iota closes the round soon');
      await sameEmbedding([anchorRemote, hiddenTwin, visibleTwin]);
      const remoteIds = ((await run(remote, 'forget', { id: String(anchorRemote) })).similar_active?.candidates ?? []).map((c: R) => Number(c.fact_id));
      expect(remoteIds).toContain(visibleTwin);
      expect(remoteIds).not.toContain(hiddenTwin);

      const anchorLocal = await visibleFact('OPENPROV-kappa closes the round late');
      await sameEmbedding([anchorLocal, hiddenTwin, visibleTwin]);
      const localIds = ((await run(local, 'forget', { id: String(anchorLocal) })).similar_active?.candidates ?? []).map((c: R) => Number(c.fact_id));
      expect(localIds).toEqual(expect.arrayContaining([hiddenTwin, visibleTwin]));
    }, 90_000);
  });
}
