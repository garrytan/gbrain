/**
 * #7172: a managed timeline entry keeps the passages it did not change, and its publication stays within a bounded
 * number of vector-index writes.
 *
 * 1. Protects: an entry appended at the end of a page whose stored page signature is stale (NULL, or an older format)
 *    keeps every unchanged passage row and its vector, and the embedding effect embeds only the passages whose text
 *    changed (effects.ts readEmbeddingEffectProjection accepts a vector whose recorded input is current and restamps
 *    the page); an entry at the top of a descending timeline keeps every passage whose text is unchanged under its
 *    old id, renumbered (import-file.ts, page-state/chunk-moves.ts), and the page ends with the passages a fresh
 *    import of the same body gives; a publication whose replacement needs more than CHUNK_VECTOR_WRITE_BUDGET
 *    vector-index writes commits with its projection pending and finishes in bounded post-commit steps
 *    (page-state/projections.ts continueDeferredProjection), resuming after an interrupted step.
 * 2. Fails when: a stale page signature re-embeds every passage; a passage whose index moves is deleted and
 *    re-inserted; a top insert publishes every moved passage inside the publication's 5 s statement bound (the
 *    PostgreSQL probe charges each vector-index write 0.6 s and shows the write ending 57014 / write_interrupted).
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt). Work is counted, never timed,
 *    except the PostgreSQL probe's injected per-row delay.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { openAppendBrain, type AppendBrain } from './helpers/append-brain.ts';
import { testBackends } from './helpers/test-backends.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { currentEmbeddingSignature } from '../src/core/embedding.ts';
import { DEFERRED_CHUNK_CLAIM, rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';
import { CHUNK_VECTOR_WRITE_BUDGET } from '../src/core/page-state/chunk-moves.ts';

const WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(' ');
function prose(seed: number, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(WORDS[(seed * 7 + i * 13 + (i % 5)) % WORDS.length]! + (i % 17 === 16 ? '.' : ''));
  return out.join(' ');
}
/** Compiled truth of `truth` paragraphs and a timeline of `bullets` dated bullets of 15 to 84 words, ascending or descending. */
function page(truth: number, bullets: number, order: 'ascending' | 'descending'): string {
  const body = Array.from({ length: truth }, (_, i) => prose(i + 1, 120)).join('\n\n');
  const lines = Array.from({ length: bullets }, (_, i) => {
    const day = order === 'ascending' ? i : bullets - 1 - i;
    return `- **${new Date(Date.UTC(2025, 0, 1 + day)).toISOString().slice(0, 10)}** | manual — Example event ${day} ${prose(day + 100, 15 + (day * 37) % 70)}`;
  });
  return `---\ntitle: Example page\ntype: note\n---\n\n${body}\n\n<!-- timeline -->\n\n## Timeline\n\n${lines.join('\n')}\n`;
}

interface Row { id: number; chunk_index: number; chunk_source: string; chunk_text: string; embedded_at: string | null; vector: boolean }

for (const kind of testBackends()) {
  describe(`#7172 timeline chunk reuse (${kind})`, () => {
    let brain: AppendBrain;
    beforeAll(async () => { brain = await openAppendBrain(kind); }, 600_000);
    afterAll(() => brain.close(), 120_000);

    const rows = (slug: string) => brain.engine.executeRaw<Row>(`SELECT c.id, c.chunk_index, c.chunk_source, c.chunk_text,
        c.embedded_at::text AS embedded_at, c.embedding IS NOT NULL AS vector
      FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id='default' AND p.slug=$1 ORDER BY c.chunk_index`, [slug]);
    const pageState = async (slug: string) => (await brain.engine.executeRaw<{ sealed: boolean; signature: string | null }>(
      `SELECT text_projection_revision IS NOT DISTINCT FROM knowledge_revision AS sealed, embedding_signature AS signature
       FROM pages WHERE source_id='default' AND slug=$1`, [slug]))[0]!;
    /** Until no persistence effect is queued or running (the background consumer drains them). */
    const settle = async () => {
      for (let i = 0; i < 600; i++) {
        const [row] = await brain.engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_effects WHERE state IN ('queued','running')");
        if (Number(row!.n) === 0) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('persistence effects did not drain');
    };
    /** A page published through put_page, every passage embedded and the effects drained. */
    const publish = async (slug: string, content: string) => {
      const put = await brain.call('put_page', { slug, content, request_id: randomUUID() });
      expect(put.isError).toBe(false);
      await settle();
      await runEmbedCore(brain.engine, { stale: true, quiet: true } as never);
      await settle();
      const stored = await rows(slug);
      expect(stored.every(row => row.vector)).toBe(true);
      expect((await pageState(slug)).sealed).toBe(true);
      return stored;
    };
    const addEntry = (slug: string, date: string, summary: string) =>
      brain.call('add_timeline_entry', { slug, date, summary, source: 'manual', request_id: randomUUID() });
    const bodyOf = async (slug: string) => {
      const stored = await brain.body(slug);
      return `---\ntitle: Example page\ntype: note\n---\n\n${stored.truth}\n\n<!-- timeline -->\n\n${stored.timeline}\n`;
    };
    /** The passages a fresh import of the page's current body gives, as (index, source, text). */
    const freshPassages = async (slug: string) => {
      const twin = `notes/twin-${randomUUID().slice(0, 8)}`;
      await brain.seed(twin, await bodyOf(slug));
      return (await rows(twin)).map(row => [row.chunk_index, row.chunk_source, row.chunk_text]);
    };
    const passages = (stored: Row[]) => stored.map(row => [row.chunk_index, row.chunk_source, row.chunk_text]);
    /** A long entry: at the top of these timelines it adds one passage there and shifts every passage below by one. */
    const LONG = `Example long entry ${prose(7, 450)}`;

    for (const stale of ['null', 'older-format'] as const) {
      test(`an entry at the end keeps every unchanged passage and its vector when the page signature is ${stale}`, async () => {
        const slug = `notes/example-stale-${stale}`;
        const before = await publish(slug, page(24, 60, 'ascending'));
        await brain.engine.executeRaw('UPDATE pages SET embedding_signature=$2 WHERE source_id=$3 AND slug=$1',
          [slug, stale === 'null' ? null : 'text-embedding-3-large:1536', 'default']);
        brain.embedded.length = 0;
        const added = await addEntry(slug, '2026-10-19', 'Example entry at the end');
        expect(added.isError).toBe(false);
        await settle();
        const after = await rows(slug);
        const old = new Map(before.map(row => [row.id, row]));
        const kept = after.filter(row => old.has(row.id));
        const unchanged = after.filter(row => before.some(prior => prior.chunk_source === row.chunk_source && prior.chunk_text === row.chunk_text));
        expect(kept.length).toBe(unchanged.length);
        expect(kept.length).toBeGreaterThanOrEqual(before.length - 1);
        // A kept passage keeps its vector: never embedded again, so its embedding time is the old one.
        for (const row of kept) expect(row.embedded_at).toBe(old.get(row.id)!.embedded_at);
        const oldTexts = new Set(before.map(row => row.chunk_text));
        expect(brain.embedded.filter(text => oldTexts.has(text))).toEqual([]);
        expect(brain.embedded.length).toBe(after.length - kept.length);
        expect(after.every(row => row.vector)).toBe(true);
        const state = await pageState(slug);
        expect(state.sealed).toBe(true);
        expect(state.signature).toBe(currentEmbeddingSignature());
      }, 600_000);
    }

    test('an entry at the top of a descending timeline keeps every unchanged passage under its id, renumbered', async () => {
      const slug = 'notes/example-descending';
      const before = await publish(slug, page(12, 380, 'descending'));
      expect(before.filter(row => row.chunk_source === 'timeline').length).toBeGreaterThan(40);
      brain.embedded.length = 0;
      const added = await addEntry(slug, '2026-10-19', LONG);
      expect(added.isError).toBe(false);
      await settle();
      const after = await rows(slug);
      const old = new Map(before.map(row => [row.id, row]));
      const kept = after.filter(row => old.has(row.id));
      const key = (row: Row) => `${row.chunk_source}\0${row.chunk_text}`;
      const beforeKeys = new Set(before.map(key));
      const unchanged = after.filter(row => beforeKeys.has(key(row)));
      console.log(`[${kind}] top insert: ${before.length} -> ${after.length} passages, ${unchanged.length} unchanged, ${kept.length} kept, ${brain.embedded.length} embedded`);
      // Every passage whose text is unchanged keeps its row (id, vector, embedding time); only the others are new.
      expect(kept.map(key).sort()).toEqual(unchanged.map(key).sort());
      expect(kept.filter(row => row.chunk_index !== old.get(row.id)!.chunk_index).length).toBeGreaterThan(CHUNK_VECTOR_WRITE_BUDGET);
      for (const row of kept) expect(row.embedded_at).toBe(old.get(row.id)!.embedded_at);
      expect(brain.embedded.length).toBe(after.length - kept.length);
      expect(after.every(row => row.vector)).toBe(true);
      expect((await pageState(slug)).sealed).toBe(true);
      expect(passages(after)).toEqual(await freshPassages(slug));
    }, 600_000);

    test('an interrupted continuation leaves the entry committed and the drain finishes it', async () => {
      const slug = 'notes/example-interrupted';
      await publish(slug, page(12, 380, 'descending'));
      // Every chunk_index move past the first CHUNK_VECTOR_WRITE_BUDGET fails, as a crash after the first step would, and
      // the reason each continuation leaves when it hands its claim back is recorded.
      await brain.engine.executeRaw(`CREATE TABLE IF NOT EXISTS probe_7172_moves (n int)`);
      await brain.engine.executeRaw(`CREATE TABLE IF NOT EXISTS probe_7172_handbacks (reason text)`);
      await brain.engine.executeRaw(`CREATE OR REPLACE FUNCTION probe_7172_interrupt() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.chunk_index IS DISTINCT FROM OLD.chunk_index THEN
            INSERT INTO probe_7172_moves VALUES (1);
            IF (SELECT count(*) FROM probe_7172_moves) > ${CHUNK_VECTOR_WRITE_BUDGET} THEN RAISE EXCEPTION 'probe_7172 interrupted'; END IF;
          END IF;
          RETURN NEW;
        END $$`);
      await brain.engine.executeRaw('CREATE TRIGGER probe_7172_interrupt BEFORE UPDATE ON content_chunks FOR EACH ROW EXECUTE FUNCTION probe_7172_interrupt()');
      await brain.engine.executeRaw(`CREATE OR REPLACE FUNCTION probe_7172_handback() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF split_part(OLD.reason, ':', 1) = '${DEFERRED_CHUNK_CLAIM}' AND NEW.reason IS DISTINCT FROM OLD.reason THEN
            INSERT INTO probe_7172_handbacks VALUES (NEW.reason);
          END IF;
          RETURN NEW;
        END $$`);
      await brain.engine.executeRaw('CREATE TRIGGER probe_7172_handback AFTER UPDATE ON page_projection_jobs FOR EACH ROW EXECUTE FUNCTION probe_7172_handback()');
      let added;
      let sealed: boolean | undefined;
      let handbacks: Array<{ reason: string }> = [];
      try {
        added = await addEntry(slug, '2026-10-19', LONG);
        // The resident's drain resumes the job once the interruption is gone, so the page is read while it is in place,
        // after the publication's continuation has handed its claim back (a reply settled at commit precedes it).
        for (let i = 0; i < 600 && !(handbacks = await brain.engine.executeRaw<{ reason: string }>('SELECT reason FROM probe_7172_handbacks')).length; i++) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        sealed = (await pageState(slug)).sealed;
      } finally {
        await brain.engine.executeRaw('DROP TRIGGER IF EXISTS probe_7172_interrupt ON content_chunks');
        await brain.engine.executeRaw('DROP FUNCTION IF EXISTS probe_7172_interrupt()');
        await brain.engine.executeRaw('DROP TABLE IF EXISTS probe_7172_moves');
        await brain.engine.executeRaw('DROP TRIGGER IF EXISTS probe_7172_handback ON page_projection_jobs');
        await brain.engine.executeRaw('DROP FUNCTION IF EXISTS probe_7172_handback()');
        await brain.engine.executeRaw('DROP TABLE IF EXISTS probe_7172_handbacks');
      }
      expect(added!.isError).toBe(false);
      // The entry is committed; the passages are not sealed yet, and the job names the deferred replacement.
      expect((await brain.body(slug)).timeline).toContain('Example long entry');
      expect(sealed).toBe(false);
      expect(handbacks.map(row => row.reason)).toEqual(['chunk_replacement_deferred']);
      // The drain resumes it from the stored rows: this call, or the resident's drain when it got there first (it holds the claim).
      await rebuildPendingPageProjections(brain.engine, 10);
      for (let i = 0; i < 600 && !(await pageState(slug)).sealed; i++) await new Promise(resolve => setTimeout(resolve, 100));
      await settle();
      await runEmbedCore(brain.engine, { stale: true, quiet: true } as never);
      const after = await rows(slug);
      expect((await pageState(slug)).sealed).toBe(true);
      expect(after.every(row => row.vector)).toBe(true);
      expect(passages(after)).toEqual(await freshPassages(slug));
    }, 600_000);

    if (kind === 'postgres') {
      test('probe: with each vector-index write charged 0.6 s, a top insert commits and no transaction makes more than the budget', async () => {
        const slug = 'notes/example-slow-index';
        await publish(slug, page(12, 380, 'descending'));
        // Each new row version that adds an HNSW entry (one carrying a vector: an insert, or an update of chunk_index, the
        // text or the vector, none of them HOT) costs 0.6 s, as on a large uncached index, and is counted per transaction.
        // A version with a NULL vector adds no HNSW entry and is not charged (chunk-moves.ts measures both).
        await brain.engine.executeRaw('CREATE TABLE probe_7172_writes (tx bigint)');
        await brain.engine.executeRaw(`CREATE OR REPLACE FUNCTION probe_7172_slow() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.embedding IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.chunk_index IS DISTINCT FROM OLD.chunk_index
              OR NEW.chunk_text IS DISTINCT FROM OLD.chunk_text OR NEW.embedding IS DISTINCT FROM OLD.embedding) THEN
              INSERT INTO probe_7172_writes VALUES (txid_current());
              PERFORM pg_sleep(0.6);
            END IF;
            RETURN NEW;
          END $$`);
        await brain.engine.executeRaw('CREATE TRIGGER probe_7172_slow BEFORE INSERT OR UPDATE ON content_chunks FOR EACH ROW EXECUTE FUNCTION probe_7172_slow()');
        let receipt: Record<string, any> = {};
        let interruptions: number | undefined;
        let writes: Array<{ n: number }> = [];
        try {
          const added = await addEntry(slug, '2026-10-19', LONG);
          const requestId = added.body.write_request?.request_id ?? added.body.request_id;
          // The reply waits a bounded time; the receipt says how the write ended.
          receipt = added.body;
          const state = () => receipt.write_request?.state ?? receipt.state;
          for (let i = 0; i < 1500 && state() !== 'committed' && state() !== 'failed'; i++) {
            await new Promise(resolve => setTimeout(resolve, 200));
            receipt = (await brain.call('get_write_request', { request_id: requestId })).body;
          }
          for (let i = 0; i < 1500 && state() === 'committed' && !(await pageState(slug)).sealed; i++) await new Promise(resolve => setTimeout(resolve, 200));
          [{ transient_interruptions: interruptions }] = await brain.engine.executeRaw<{ transient_interruptions: number }>(
            'SELECT transient_interruptions FROM persistence_requests WHERE request_id=$1', [requestId]);
          writes = await brain.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM probe_7172_writes GROUP BY tx ORDER BY 1 DESC');
        } finally {
          await brain.engine.executeRaw('DROP TRIGGER IF EXISTS probe_7172_slow ON content_chunks');
          await brain.engine.executeRaw('DROP FUNCTION IF EXISTS probe_7172_slow()');
          await brain.engine.executeRaw('DROP TABLE IF EXISTS probe_7172_writes');
        }
        console.log(`[probe] state ${receipt.write_request?.state ?? receipt.state}, interruptions ${interruptions}, vector-index writes per transaction ${JSON.stringify(writes.map(w => w.n))}`);
        if ((receipt.write_request?.state ?? receipt.state) !== 'committed') console.log(JSON.stringify(receipt).slice(0, 1200));
        expect(receipt.write_request?.state ?? receipt.state).toBe('committed');
        expect(Number(interruptions)).toBe(0);
        expect(Number(writes[0]?.n ?? 0)).toBeLessThanOrEqual(CHUNK_VECTOR_WRITE_BUDGET);
        await settle();
        expect((await pageState(slug)).sealed).toBe(true);
        expect(passages(await rows(slug))).toEqual(await freshPassages(slug));
      }, 900_000);
    }
  });
}
