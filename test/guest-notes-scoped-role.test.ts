/**
 * Guest notes under a scoped database role (follow-up 3 of #9354). The guest guard in the trust trigger and guest
 * admission read guest_sources as the role doing the write. A role that neither owns guest_sources nor bypasses RLS,
 * with no policy on it, read it empty, so a write into a guest source passed as if the source were ordinary.
 * Contract: guest_sources hidden by row-level security is never read as "no guest source". The trigger refuses the
 * write (writer_coordinator_required, unreadable_state, state guest_sources) and the admission reads refuse with the
 * same code. A role holding the docs/ENGINES.md maintainer recipe (guest_sources included) tells guest sources apart
 * as before. Postgres only (PGLite has no roles): it runs in the unit-lane PostgreSQL arms (test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { readGuestSource } from '../src/core/guests/sources.ts';
import { refuseGuestSourceWrite, refuseRemoteGuestDelete } from '../src/core/guests/admission.ts';
import { ADMISSION_SOURCE_SQL } from '../src/core/persistence/preadmit-cache.ts';
import type { Principal } from '../src/core/persistence/model.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const SCOPED = `gbrain_guest_scoped_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const UNREADABLE = /writer_coordinator_required: writer state is unreadable to this database role/;
const BROKER: Principal = { kind: 'oauth_client', id: 'client-a' };
const OTHER: Principal = { kind: 'oauth_client', id: 'client-b' };
const GUESTS = 'guests-scoped';

(testBackends().includes('postgres') ? describe : describe.skip)('guest notes under a scoped database role (Postgres)', () => {
  let engine: BrainEngine;
  let close: (() => Promise<void>) | undefined;
  let tables: string[] = [];
  let guestPage = { id: 0, slug: '' };

  /** Open policies for the scoped role on every table except `hidden`. */
  async function policies(hidden: string[]) {
    for (const table of tables) {
      await engine.executeRaw(`DROP POLICY IF EXISTS ${SCOPED}_open ON ${table}`);
      if (!hidden.includes(table)) await engine.executeRaw(`CREATE POLICY ${SCOPED}_open ON ${table} FOR ALL TO ${SCOPED} USING (true) WITH CHECK (true)`);
    }
  }
  /** Runs `fn` as the scoped role writing as `principal`, in a transaction that rolls back. */
  async function asScoped<T>(principal: Principal, fn: (tx: BrainEngine) => Promise<T>): Promise<{ value?: T; error?: string; code?: string; state?: string }> {
    const marker = new Error('scoped-probe-rollback');
    let value: T | undefined;
    try {
      await engine.transaction(async tx => {
        await tx.executeRaw(`SET LOCAL ROLE ${SCOPED}`);
        await tx.executeRaw('SELECT set_config(\'gbrain.write_principal_kind\',$1,true), set_config(\'gbrain.write_principal_id\',$2,true)', [principal.kind, principal.id]);
        value = await fn(tx);
        throw marker;
      });
    } catch (e) {
      if (e !== marker) {
        const detail = (e as { detail?: string }).detail;
        return { error: (e as Error).message, ...((e as { code?: string }).code ? { code: (e as { code?: string }).code } : {}),
          ...(detail?.startsWith('{') ? { state: JSON.parse(detail).state } : {}) };
      }
    }
    return { value };
  }
  const insertPage = (tx: BrainEngine, sourceId: string) => tx.executeRaw(
    `INSERT INTO pages(source_id,slug,type,title,compiled_truth,content_hash) VALUES($1,$2,'note','T','b',repeat('a',64)) RETURNING id, slug`,
    [sourceId, `guests/${randomUUID().slice(0, 8)}`]);

  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engine = pg.engine; close = pg.close;
    await engine.executeRaw(`CREATE ROLE ${SCOPED} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await engine.executeRaw(`GRANT USAGE ON SCHEMA public TO ${SCOPED}`);
    await engine.executeRaw(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${SCOPED}`);
    await engine.executeRaw(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${SCOPED}`);
    tables = (await engine.executeRaw<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map(r => r.t);
    await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES($1,$1,'{"federated":true,"guest":true}'::jsonb)`, [GUESTS]);
    await engine.executeRaw(`INSERT INTO guest_sources(source_id,writers) VALUES($1,ARRAY['oauth_client:client-a'])`, [GUESTS]);
    const request = randomUUID();
    const [page] = await engine.transaction(async tx => {
      await tx.executeRaw(`SELECT set_config('gbrain.write_principal_kind','oauth_client',true), set_config('gbrain.write_principal_id','client-a',true),
        set_config('gbrain.write_request',$1,true), set_config('gbrain.guest_note',$1,true)`, [request]);
      return insertPage(tx, GUESTS) as Promise<Array<{ id: number; slug: string }>>;
    });
    guestPage = page!;
  }, 180_000);
  afterAll(async () => {
    if (engine) {
      await engine.executeRaw(`DROP OWNED BY ${SCOPED}`).catch(() => undefined);
      await engine.executeRaw(`DROP ROLE IF EXISTS ${SCOPED}`);
      await disposePersistenceConsumer(engine);
      await engine.disconnect();
    }
    await close?.();
    resetGateway();
  });

  test('the trigger refuses an unlisted page write into a guest source it cannot see as one', async () => {
    await policies(['guest_sources']);
    expect(await asScoped(OTHER, tx => insertPage(tx, GUESTS))).toEqual({ error: expect.stringMatching(UNREADABLE), code: 'P0001', state: 'guest_sources' });
  });

  test('the trigger refuses an ordinary page write too, since the role cannot tell the sources apart', async () => {
    await policies(['guest_sources']);
    expect(await asScoped(OTHER, tx => insertPage(tx, 'default'))).toEqual({ error: expect.stringMatching(UNREADABLE), code: 'P0001', state: 'guest_sources' });
  });

  test('the trigger refuses a fact, take or timeline row it cannot place outside a guest source', async () => {
    await policies(['guest_sources']);
    expect((await asScoped(OTHER, tx => tx.executeRaw(`INSERT INTO facts(source_id,entity_slug,fact,kind,source) VALUES($1,'e','claim','fact','test')`, [GUESTS]))).state)
      .toBe('guest_sources');
    expect((await asScoped(OTHER, tx => tx.executeRaw(`INSERT INTO timeline_entries(page_id,date,summary,detail,source) VALUES($1,'2026-01-01','s','d','x')`, [guestPage.id]))).state)
      .toBe('guest_sources');
  });

  test('admission reads refuse instead of reading the guest source as ordinary', async () => {
    await policies(['guest_sources']);
    expect((await asScoped(OTHER, tx => readGuestSource(tx, GUESTS))).error).toMatch(/writer_coordinator_required|guest_sources/);
    expect((await asScoped(OTHER, tx => refuseGuestSourceWrite(tx, GUESTS, async () => OTHER, 'remember'))).error).toMatch(/guest_sources/);
    expect((await asScoped(OTHER, tx => refuseRemoteGuestDelete(tx, GUESTS, guestPage.slug, OTHER))).error).toMatch(/guest_sources/);
    const admission = await asScoped(OTHER, tx => tx.executeRaw<Record<string, unknown>>(ADMISSION_SOURCE_SQL, [GUESTS]));
    expect(admission.value?.[0]?.guest_sources_hidden).toBe(true);
  });

  test('with a guest_sources policy the role tells guest sources apart as before', async () => {
    await policies([]);
    expect((await asScoped(OTHER, tx => insertPage(tx, GUESTS))).error).toMatch(/source_writer_restricted/);
    expect((await asScoped(OTHER, tx => insertPage(tx, 'default'))).error).toBeUndefined();
    expect((await asScoped(BROKER, tx => readGuestSource(tx, GUESTS))).value).toMatchObject({ source_id: GUESTS, writers: ['oauth_client:client-a'] });
    const admission = await asScoped(OTHER, tx => tx.executeRaw<Record<string, unknown>>(ADMISSION_SOURCE_SQL, [GUESTS]));
    expect(admission.value?.[0]).toMatchObject({ guest_writers: ['oauth_client:client-a'], guest_sources_hidden: false });
  });
});
