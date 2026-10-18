/**
 * restore_page of a file-backed segmented page over the single-string ceiling writes its canonical file once, even
 * when the publication transaction's statement bound ends a statement (Wave B, PR 2 fix lane Y).
 *
 * 1. Protects: the restore's publication transaction runs no read whose cost grows with the page (the probes for
 *    occurrences without chunks and for stale chunk rows, one index probe per occurrence). Those decide whether the
 *    restore seals the page, and run in preparation; the transaction only seals. The page still ends sealed, with its
 *    file streamed into its staging file exactly once.
 * 2. Fails when: a probe runs inside the publication transaction, where `declareDurablePersistence`'s 5 s
 *    `statement_timeout` ends it on a loaded host (57014). That failure is transient: recovery requeues the request,
 *    and the owner prepares it again and streams the whole file again, once per cancelled attempt (CI stress saw a
 *    90 MiB restore written two and four times, one cancelled stale-chunk probe per extra write). The probe here
 *    makes the first in-transaction run of either probe end as the server ends it (57014); without the fix the file
 *    is streamed twice.
 * 3. Existing coverage: segmented-delete-restore-file.slow.test.ts checks a restore streams its file once, on an idle
 *    host only; restore-segmented-reprojects.test.ts and restore-deferred-retire.test.ts check the seal decision.
 * 4. Forced with an engine view whose transactions fail the first probe statement; counts, never time.
 *    Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, describe, expect, test, beforeAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { importManagedFile } from '../../src/core/persistence/import-mutations.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { largeFileWork } from '../../src/core/persistence/large-file.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { fileSha, writeCanonicalPage } from '../helpers/large-page-file.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-restore-statement-bound-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const logger = { info() {}, warn() {}, error() {} };
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

/** The two probes the seal decision runs (page-body/ingest.ts occurrencesWithoutChunks, projection.ts STALE_CHUNKS_SQL). */
const SEAL_PROBES = ['FROM unnest($2::bigint[]) AS o', 'WITH RECURSIVE occ(o)'];
/** The statement a publication transaction opens with (protocol.ts declareDurablePersistence). */
const DECLARE_PUBLICATION = "set_config('gbrain.persistence_protocol'";

/**
 * The engine whose publication transactions end the first seal probe they run as the server ends a statement at the
 * publication's `statement_timeout`. `probes.inPublication` counts the probes publication transactions ran.
 */
function statementBound(engine: BrainEngine) {
  const probes = { inPublication: 0, cancelled: 0 };
  const inTx = (tx: BrainEngine): BrainEngine => {
    let publication = false;
    return new Proxy(tx, { get(target, prop) {
      if (prop === 'executeRaw') return (sql: string, params?: unknown[], opts?: unknown) => {
        if (sql.includes(DECLARE_PUBLICATION)) publication = true;
        if (publication && SEAL_PROBES.some(probe => sql.includes(probe)) && probes.inPublication++ === 0) {
          probes.cancelled++;
          return Promise.reject(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
        }
        return target.executeRaw(sql, params, opts as never);
      };
      if (prop === 'transaction') return (fn: (inner: BrainEngine) => Promise<unknown>, opts?: unknown) => target.transaction(inner => fn(inTx(inner)), opts as never);
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  const view = new Proxy(engine, { get(target, prop) {
    if (prop === 'transaction') return (fn: (tx: BrainEngine) => Promise<unknown>, opts?: unknown) => target.transaction(tx => fn(inTx(tx)), opts as never);
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { view, probes };
}

/** A write over the reply wait is repeated with its request_id until it settles. */
async function settled<T>(call: () => Promise<T>): Promise<T> {
  for (;;) {
    try { return await call(); }
    catch (error) { if ((error as { code?: string }).code !== 'write_pending') throw error; await Bun.sleep(500); }
  }
}

for (const kind of testBackends()) describe(`restore_page under the publication statement bound (${kind})`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  beforeAll(async () => withEnv(env, async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; close = () => lite.disconnect(); }
  }), 120_000);
  afterAll(async () => withEnv(env, async () => { await close?.(); }));

  test('a page over the ceiling restores sealed, its file streamed once, with no seal probe in the transaction', async () => withEnv(env, async () => {
    const { view, probes } = statementBound(engine);
    await view.setConfig('pages.segmented_storage', 'on');
    const root = join(home, `src-${randomUUID().slice(0, 8)}`);
    mkdirSync(join(root, 'notes'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root });
    const sourceId = `rb-${randomUUID().slice(0, 8)}`;
    await view.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await view.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
    await registerLocalWriter(view, 'cli');
    await claimWorktree(view, sourceId, root);
    await view.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const ctx = { engine: view, sourceId, remote: false, config: { engine: view.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
    const slug = 'notes/bound';
    const file = join(root, `${slug}.md`);
    const submit = async (operation: 'delete_page' | 'restore_page') => {
      const params = { slug, expected_revision: (await view.readPageSnapshot(slug, { sourceId, includeDeleted: true }))!.revision, request_id: randomUUID() };
      return settled(() => submitPageMutation(ctx, { operation, params }) as Promise<Record<string, unknown>>);
    };
    const sealed = async () => (await engine.executeRaw<{ sealed: boolean; deleted: boolean }>(`SELECT
      text_projection_revision IS NOT DISTINCT FROM knowledge_revision AS sealed, deleted_at IS NOT NULL AS deleted
      FROM pages WHERE source_id=$1 AND slug=$2`, [sourceId, slug]))[0];
    try {
      const original = writeCanonicalPage(file, PAGE_MAX_BYTES + 1024 * 1024, 301);
      expect(await settled(() => importManagedFile(view, file, `${slug}.md`, { sourceId, noEmbed: true }))).toMatchObject({ status: 'imported' });
      for (let polls = 0; !(await sealed()).sealed && polls < 600; polls++) await Bun.sleep(100);
      expect(await sealed()).toEqual({ sealed: true, deleted: false });
      expect(await submit('delete_page')).toMatchObject({ status: 'soft_deleted', noop: false });
      expect(existsSync(file)).toBe(false);

      for (const key of Object.keys(probes) as Array<keyof typeof probes>) probes[key] = 0;
      for (const key of Object.keys(largeFileWork) as Array<keyof typeof largeFileWork>) largeFileWork[key] = 0;
      const restored = await submit('restore_page');
      expect(restored).toMatchObject({ status: 'restored', noop: false });
      expect(statSync(file).size).toBe(original.size);
      expect(fileSha(file)).toBe(original.sha);
      expect(readdirSync(join(root, 'notes')).filter(name => name.includes('.tmp.'))).toEqual([]);
      expect(largeFileWork.bytesWritten).toBe(original.size);
      expect(probes).toEqual({ inPublication: 0, cancelled: 0 });
      expect(await sealed()).toEqual({ sealed: true, deleted: false });
    } finally {
      await disposePersistenceConsumer(view);
      rmSync(root, { recursive: true, force: true });
    }
  }), 600_000);
});
