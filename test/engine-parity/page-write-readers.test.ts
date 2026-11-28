/**
 * BrainEngine parity: the put_page write guard for the readers key.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: put_page, run through the real operation handler on each engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm through test/engine-parity/harness.ts), refuses content whose frontmatter names its
 *    readers with a key that is not exactly `readable_by` (`Readable_By: [alice-example]`) with the code
 *    `readers_noncanonical`, and the page does not exist afterward. The exact key still stores the page.
 *  - Regression: an engine or a write path that lets the misspelled key through stores a page every member can
 *    read while its author believes it is restricted (page access reads only the exact key).
 *  - Why existing coverage misses it: the cases in this directory call typed engine members; none runs the write
 *    guard in page-prepare.ts, which is shared TypeScript that every engine's put_page goes through.
 *  - Seam: the put_page operation handler over the arm's engine. The write path still reads and writes through raw
 *    SQL, so the case requires `raw_sql`; an engine without it stops on the typed refusal before the guard.
 *    The Rust arm is such an engine today: its first write (the `exact` page) stops on `engine_capability_missing`
 *    (raw_sql), the harness counts that as a stop, and the guard itself is reached only on the SQL arms until the
 *    Rust engine serves the write path.
 */
import { describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { operations } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { requestPrincipalForContext } from '../../src/core/persistence/page-mutations.ts';
import { createSource, parityArms } from './harness.ts';
import type { RustEngine } from '../../src/core/rust-engine.ts';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const putPage = operations.find((op) => op.name === 'put_page')!;
const page = (extra: string) => `---\ntitle: Example\ntype: note\n${extra}---\nA page about acme-example.\n`;

describe('engine parity: put_page readers key guard', () => {
  parityTest('put_page refuses a misspelled readable_by key as readers_noncanonical and stores nothing; the exact key still stores', {
    methods: ['getPage'], requires: 'raw_sql',
  }, async (engine) => {
    const ctx = { engine, sourceId: 'default', remote: false, dryRun: false, config: { engine: engine.kind, embedding_disabled: true },
      logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    const put = (slug: string, content: string) => (putPage.handler(ctx, { slug, content, request_id: randomUUID(), wait_ms: 25_000 }) as Promise<Record<string, unknown>>)
      .then((result) => ({ code: null as string | null, status: String(result.status) }), (e: { code?: string }) => {
        // An engine without raw SQL stops on its typed refusal; the harness reads that as the arm's outcome, so it must reach it.
        if (e.code === 'engine_capability_missing') throw e;
        return { code: e.code ?? null, status: 'refused' };
      });
    try {
      const outcomes: Record<string, { code: string | null; status: string }> = {
        exact: await put('notes/exact', page('readable_by: [alice-example]\n')),
        cased: await put('notes/cased', page('Readable_By: [alice-example]\n')),
        hyphen: await put('notes/hyphen', page('readable-by: [alice-example]\n')),
        camel: await put('notes/camel', page('readableBy: [alice-example]\n')),
        both: await put('notes/both', page('readable_by: [alice-example]\nREADABLE_BY: [bob-example]\n')),
      };
      const stored: Record<string, boolean> = {};
      for (const slug of ['exact', 'cased', 'hyphen', 'camel', 'both']) stored[slug] = (await engine.getPage(`notes/${slug}`)) !== null;
      expect(outcomes.exact!.code).toBeNull();
      for (const key of ['cased', 'hyphen', 'camel', 'both']) expect({ key, code: outcomes[key]!.code }).toEqual({ key, code: 'readers_noncanonical' });
      expect(stored).toEqual({ exact: true, cased: false, hyphen: false, camel: false, both: false });
      return { outcomes, stored };
    } finally {
      await disposePersistenceConsumer(engine);
    }
  });
});

/**
 * A shared skillpack registered for a source reserves `skills/...` and `skillpack.json` in it: a knowledge put there is
 * refused with `skill_bundle_required` (shared-skills/knowledge-guard.ts) before anything is written. The pack row is
 * seeded per arm: SQL into shared_skill_packs, and on Rust through the store's own publication calls (activation needs a
 * source with a local path, so the case registers one).
 */
describe('engine parity: put_page shared skillpack guard', () => {
  parityTest('put_page of a reserved skills/ page in a source with a shared skillpack is refused and stores nothing', {
    methods: ['getPage', 'readSourceState'],
  }, async (engine, backend) => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-pack-guard-'));
    const ctx = { engine, sourceId: 'default', remote: false, dryRun: false, config: { engine: engine.kind, embedding_disabled: true },
      logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    try {
      await createSource(engine, backend, 'pack-root', {}, root);
      const incarnation = (await engine.readSourceState('default'))!.incarnation;
      const pack = { sourceId: 'default', incarnation, packId: 'pack-a', revision: randomUUID(), manifest: { skills: [] }, manifestHash: 'h' };
      if (backend === 'rust') {
        const { brain } = (engine as unknown as RustEngine).openStore('writeSharedSkillPack') as unknown as { brain: {
          activateSharedSkillPublication(dryRun: boolean): Promise<unknown>; writeSharedSkillPack(write: typeof pack): Promise<null> } };
        await brain.activateSharedSkillPublication(false);
        await brain.writeSharedSkillPack(pack);
      } else {
        // The row as an adopted pack leaves it; the publication trigger (which wants protocol 2) is off for the seed only.
        await engine.transaction(async (tx) => {
          await tx.executeRaw('SET LOCAL session_replication_role = replica');
          await tx.executeRaw('INSERT INTO shared_skill_packs (source_id,source_incarnation,pack_id,revision,manifest,manifest_hash) VALUES ($1,$2::uuid,$3,$4::uuid,$5::jsonb,$6)',
            [pack.sourceId, pack.incarnation, pack.packId, pack.revision, JSON.stringify(pack.manifest), pack.manifestHash]);
        });
      }
      const content = '---\ntitle: Planted\ntype: note\n---\nPlanted skill text.\n';
      const outcome = await (putPage.handler(ctx, { slug: 'skills/planted/skill', content, request_id: randomUUID(), wait_ms: 25_000 }) as Promise<Record<string, unknown>>)
        .then((result) => ({ code: null as string | null, status: String(result.status) }), (e: { code?: string }) => {
          if (e.code === 'engine_capability_missing') throw e;
          return { code: e.code ?? null, status: 'refused' };
        });
      const stored = (await engine.getPage('skills/planted/skill')) !== null;
      expect({ outcome, stored }).toEqual({ outcome: { code: 'skill_bundle_required', status: 'refused' }, stored: false });
      return { outcome, stored };
    } finally {
      await disposePersistenceConsumer(engine);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * A put to a source with a checkout but no canonical owner, which `persistence.unbound_write=database_only` (and, on
 * PGLite, activation's database-only list) writes database-only. PGLite stores the page and writes no file. The Rust
 * engine cannot publish it (the publication rechecks the binding and stamps the page through raw SQL), so it must refuse
 * with the typed raw_sql refusal before admission: no write request is journaled, so no failed receipt is left behind.
 */
describe('engine parity: put_page to an unbound source, database-only', () => {
  parityTest('a database-only put to an unbound source stores the page and no file; Rust refuses it before admission', {
    methods: ['getPage'], requires: 'raw_sql',
  }, async (engine, backend) => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-unbound-db-only-'));
    const ctx = { engine, sourceId: 'unbound', remote: false, dryRun: false, config: { engine: engine.kind, embedding_disabled: true },
      logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    const requestId = randomUUID();
    try {
      await createSource(engine, backend, 'unbound', {}, root);
      await engine.setConfig('persistence.unbound_write', 'database_only');
      await engine.setConfig('persistence.database_only_sources', JSON.stringify(['unbound']));
      try {
        const result = await putPage.handler(ctx, { slug: 'notes/unbound', content: page(''), request_id: requestId, wait_ms: 25_000 }) as Record<string, unknown>;
        return { status: String(result.status), stored: (await engine.getPage('notes/unbound', { sourceId: 'unbound' })) !== null,
          files: readdirSync(root, { recursive: true }).map(String) };
      } catch (error) {
        const principal = await requestPrincipalForContext(ctx);
        expect({ journaled: (await engine.readWriteRequest(principal.kind, principal.id, requestId))?.state ?? null }).toEqual({ journaled: null });
        throw error;
      }
    } finally {
      await disposePersistenceConsumer(engine);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
