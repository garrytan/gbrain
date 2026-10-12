/**
 * #6500: `extract-conversation-facts` listed a page twice under OFFSET paging
 * over `updated_desc` (not a total order), extracted it twice and submitted a
 * batch naming it twice, which the envelope validator refused
 * (`invalid_params`) and then blocked every member deterministically.
 *
 * Protects: (a) `updated_desc` carries slug/source/id tiebreakers so a tie
 * cluster lists deterministically; (b) `slugAfter` keyset enumeration walks a
 * single source's pages exactly once while tied rows are touched mid-walk;
 * (c) one run never extracts or enqueues the same page twice
 * (`pages_skipped_duplicate_listing`); (d) a failed envelope counts once per
 * request, not once per member, so a historical envelope that listed one
 * generation three times is resubmitted from its stored entry; (e) a refused
 * `invalid_params` envelope is retryable and replays its stored entries with
 * zero model calls, while a genuinely malformed replay still reaches
 * MAX_GENERATION_ATTEMPTS and blocks, with the page's prior rows untouched.
 * Fails when: the tiebreaker is missing (insertion order returned), the
 * keyset filter is ignored (the first window repeats), the claimed set is
 * missing (two model calls, refused batch), failures are counted per member
 * (the page is blocked), or `invalid_params` is deterministic (blocked).
 * Seams: the Core's injected extractor and the persistence fault hook.
 * PGLite always; Postgres when DATABASE_URL is set
 * (test/e2e/conversation-facts-keyset-6500-postgres.test.ts).
 */
import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ExtractedFact } from '../src/core/facts/extract.ts';
import { runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';
import { CONVERSATION_FACTS_INTENT, MAX_GENERATION_ATTEMPTS } from '../src/core/facts/conversation-publication.ts';
import { PAGE_SORT_SQL } from '../src/core/types.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { managedBrain, type ManagedBrain } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const SLUG = 'meetings/2026-09-28-plan-sync';
const transcript = () => [
  '---', 'title: Plan sync', 'type: meeting', 'date: 2026-09-28', '---',
  '**Alice Example:** Can you send me the quarterly plan before the review?',
  '**Owner Example:** Yes, I will send it on Thursday with the finance appendix.',
  '**Alice Example:** Good. I review plans on Mondays, so that works.',
  '**Owner Example:** I will flag any launch date changes in the summary.', '',
].join('\n');

afterEach(() => { installFaultHook(undefined); });

async function putPage(brain: ManagedBrain, content: string, slug = SLUG): Promise<void> {
  await submitPageMutation(brain.ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content } });
  await disposePersistenceConsumer(brain.engine);
}

async function extract(engine: BrainEngine, calls: { n: number }, slugs: string[] = [SLUG]) {
  return runExtractConversationFactsCore(engine, { sourceId: 'default', slugs, sleepMs: 0, overrideDisabled: true,
    extractor: async () => {
      calls.n++;
      return [{ fact: 'Owner Example sends the quarterly plan on Thursday', kind: 'commitment', confidence: 0.9, entity_slug: null,
        source: 'test', notability: 'high' } as ExtractedFact];
    } });
}

/** A direct SQL edit of durable rows on the managed brain (seeding history), outside the writer guard. */
async function seedRaw(engine: BrainEngine, sql: string, params: unknown[] = []): Promise<void> {
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true),set_config('gbrain.persistence_protocol','2',true),set_config('gbrain.write_sources','[\"default\"]',true)");
    await tx.executeRaw(sql, params);
  });
  await disposePersistenceConsumer(engine);
}

async function requests(engine: BrainEngine) {
  return engine.executeRaw<{ id: string; state: string; error_code: string | null; members: number }>(
    `SELECT id::text AS id, state, error_code, jsonb_array_length(intent->'pages')::int AS members FROM persistence_requests WHERE intent->>'kind'=$1 ORDER BY sequence`,
    [CONVERSATION_FACTS_INTENT]);
}

async function factsOf(engine: BrainEngine, slug: string) {
  return (await engine.executeRaw<{ fact: string }>(`SELECT fact FROM facts WHERE source_id='default' AND source_markdown_slug=$1
    AND source LIKE 'cli:extract-conversation-facts%' AND expired_at IS NULL ORDER BY row_num`, [slug])).map(r => r.fact);
}

/** One extraction whose publication the owner refuses once (retryable): leaves one failed request holding the page's stored entry. */
async function seedFailedEnvelope(brain: ManagedBrain, calls: { n: number }): Promise<string> {
  let fail = true;
  installFaultHook(async point => { if (point === 'consumer:prepared' && fail) { fail = false; throw Object.assign(new Error('simulated owner crash'), { code: 'storage_error' }); } });
  const first = await extract(brain.engine, calls);
  installFaultHook(undefined);
  expect(first).toMatchObject({ pages_processed: 0, pages_failed: 1 });
  expect(calls.n).toBe(1);
  const [failed] = await requests(brain.engine);
  expect(failed).toMatchObject({ state: 'failed', members: 1 });
  return failed!.id;
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test(`${backend}: updated_desc orders a tie cluster by slug and the slug keyset lists each page once while tied rows are touched`, async () => {
    expect(PAGE_SORT_SQL.updated_desc).toBe('p.updated_at DESC, p.slug DESC, p.source_id DESC, p.id DESC');
    const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      const slugs = Array.from({ length: 200 }, (_, i) => `meetings/m${String(i).padStart(3, '0')}`);
      for (const slug of slugs) await engine.putPage(slug, { type: 'meeting', title: slug, compiled_truth: `# ${slug}\n\nbody` });
      await engine.executeRaw(`UPDATE pages SET updated_at = '2026-01-01T00:00:00Z' WHERE source_id='default' AND type='meeting'`);

      const desc = await engine.listPages({ type: 'meeting', sourceId: 'default', limit: 200 });
      expect(desc.map(p => p.slug)).toEqual([...slugs].sort().reverse());

      // Keyset walk, touching an already-listed tied row between windows (what any concurrent stamp or connector write does).
      const seen: string[] = [];
      let after: string | undefined;
      for (let window = 0; window < 25; window++) {
        const batch = await engine.listPages({ type: 'meeting', sourceId: 'default', sort: 'slug', slugAfter: after, limit: 10 });
        if (batch.length === 0) break;
        seen.push(...batch.map(p => p.slug));
        after = batch.at(-1)!.slug;
        await engine.executeRaw(`UPDATE pages SET title = title || ' (touched)' WHERE source_id='default' AND slug=$1`, [batch[0]!.slug]);
        if (batch.length < 10) break;
      }
      expect(seen.length).toBe(200);
      expect(new Set(seen).size).toBe(200);
      expect([...seen].sort()).toEqual(slugs);

      // The offset walk over updated_desc is deterministic for fixed timestamps too.
      const offsetSeen: string[] = [];
      for (let offset = 0; offset < 200; offset += 10) {
        const batch = await engine.listPages({ type: 'meeting', sourceId: 'default', limit: 10, offset });
        offsetSeen.push(...batch.map(p => p.slug));
        await engine.executeRaw(`UPDATE pages SET title = title || ' (again)' WHERE source_id='default' AND slug=$1`, [batch[0]!.slug]);
      }
      expect(offsetSeen).toEqual([...slugs].sort().reverse());
    } finally { await close(); }
  }, 120_000);

  test(`${backend}: the same page fed twice to one run is extracted once and published in one request`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      await putPage(brain, transcript());
      const calls = { n: 0 };
      const result = await extract(engine, calls, [SLUG, SLUG]);
      expect(calls.n).toBe(1);
      expect(result).toMatchObject({ pages_processed: 1, facts_inserted: 1, pages_failed: 0, pages_skipped_duplicate_listing: 1 });
      expect(await requests(engine)).toMatchObject([{ state: 'committed', error_code: null, members: 1 }]);
      expect(await factsOf(engine, SLUG)).toEqual(['Owner Example sends the quarterly plan on Thursday', 'EXTRACTION_COMPLETE']);
    }, { databaseUrl });
  }, 120_000);

  test(`${backend}: one failed envelope holding a generation three times counts as one failed request; its stored entry is resubmitted without a model call`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      await putPage(brain, transcript());
      const calls = { n: 0 };
      const id = await seedFailedEnvelope(brain, calls);
      // A historical envelope that listed the page three times (the reporter's refused batch shape).
      await seedRaw(engine, `UPDATE persistence_requests SET intent = jsonb_set(intent, '{pages}', (intent->'pages') || (intent->'pages') || (intent->'pages')) WHERE id=$1::uuid`, [id]);
      expect((await requests(engine))[0]).toMatchObject({ state: 'failed', members: 3 });
      const second = await extract(engine, calls);
      expect(second).toMatchObject({ pages_processed: 1, facts_inserted: 1, pages_failed: 0 });
      expect(second.pages_blocked ?? 0).toBe(0);
      expect(calls.n).toBe(1);
      expect((await requests(engine)).map(r => r.state)).toEqual(['failed', 'committed']);
      expect(await factsOf(engine, SLUG)).toEqual(['Owner Example sends the quarterly plan on Thursday', 'EXTRACTION_COMPLETE']);
    }, { databaseUrl });
  }, 120_000);

  test(`${backend}: a refused invalid_params envelope is resubmitted from its stored entries with zero model calls`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      await putPage(brain, transcript());
      const calls = { n: 0 };
      const id = await seedFailedEnvelope(brain, calls);
      await seedRaw(engine, `UPDATE persistence_requests SET error_code='invalid_params', error_message='names a page twice' WHERE id=$1::uuid`, [id]);
      const second = await extract(engine, calls);
      expect(second).toMatchObject({ pages_processed: 1, facts_inserted: 1 });
      expect(calls.n).toBe(1);
      expect((await requests(engine)).map(r => [r.state, r.error_code])).toEqual([['failed', 'invalid_params'], ['committed', null]]);
    }, { databaseUrl });
  }, 120_000);
}

test('pglite: a genuinely malformed envelope replays its stored entries with zero model calls until MAX_GENERATION_ATTEMPTS, then stays blocked; the page\'s rows are untouched', async () => {
  await managedBrain(async brain => {
    const { engine } = brain;
    await putPage(brain, transcript());
    // A prior row from another writer on the same page: the refused replays must leave it alone.
    await seedRaw(engine, `INSERT INTO facts (source_id, fact, kind, source, source_markdown_slug, visibility) VALUES ('default', 'A manual note about the plan', 'fact', 'manual', $1, 'private')`, [SLUG]);
    const rowsBefore = await engine.executeRaw<{ id: number; fact: string }>(`SELECT id, fact FROM facts WHERE source_id='default' AND source_markdown_slug=$1 ORDER BY id`, [SLUG]);
    expect(rowsBefore).toHaveLength(1);
    const calls = { n: 0 };
    const id = await seedFailedEnvelope(brain, calls);
    // The stored member names no page: every replay of this envelope is refused by the validator.
    await seedRaw(engine, `UPDATE persistence_requests SET intent = jsonb_set(intent, '{pages,0,slug}', '""'::jsonb) WHERE id=$1::uuid`, [id]);
    const lines: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return write(chunk); }) as typeof process.stderr.write;
    try {
      for (let attempt = 2; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
        const replay = await extract(engine, calls);
        expect(replay).toMatchObject({ pages_processed: 0, pages_failed: 1 });
        expect(replay.pages_blocked ?? 0).toBe(0);
        expect((await requests(engine)).map(r => r.state)).toEqual(Array(attempt).fill('failed'));
        expect((await requests(engine)).at(-1)!.error_code).toBe('invalid_params');
      }
      const blocked = await extract(engine, calls);
      expect(blocked).toMatchObject({ pages_processed: 0, pages_failed: 0, pages_blocked: 1 });
      expect((await requests(engine)).map(r => r.state)).toEqual(Array(MAX_GENERATION_ATTEMPTS).fill('failed'));
      expect(lines.join('')).toContain(`${MAX_GENERATION_ATTEMPTS} batch requests holding it failed at this page version, so no model call runs again until the page changes`);
      expect(lines.join('')).toContain('gbrain write-request --');
      // The bound is durable: a fresh run still blocks.
      expect((await extract(engine, calls)).pages_blocked).toBe(1);
    } finally { process.stderr.write = write; }
    expect(calls.n).toBe(1);
    expect(await engine.executeRaw(`SELECT id, fact FROM facts WHERE source_id='default' AND source_markdown_slug=$1 ORDER BY id`, [SLUG])).toEqual(rowsBefore);
  });
}, 120_000);
