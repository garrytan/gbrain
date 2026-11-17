/**
 * GBRA-574 B2 + G4: conversation facts carry a slot (dimension, value) on the ontology columns, and the query facts
 * block derives each slot value's validity window at read time from the slot's chronology.
 *
 * Protects: the conversation publication stores dimension, value, value_hash and dim_status on unmanaged and managed
 * brains; a page whose batch repeats a slot key, a re-extraction that expires a referenced slot row, and --force twice
 * never fail the insert; a value ends when the next distinct value is on the same page, or its fact states a change in
 * plain English; across pages without a change cue both values stay open with no label (G4); a restatement continues a
 * stint; a stored valid_until wins; ingest order does not change the block; a slot row the caller cannot see (a remote
 * caller and a private fact) or a withdrawn one never ends a window; facts without slots render as before;
 * findOntologyConflicts keeps its output for ontology rows and ignores conversation rows.
 * PGLite (no git), and Postgres through test/e2e/facts-slot-windows-gbra574-postgres.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ExtractedFact } from '../src/core/facts/extract.ts';
import { runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';
import { valueHash } from '../src/core/chronicle/ontology.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { managedBrain, type ManagedBrain } from './helpers/managed-brain.ts';

const ALICE = 'people/alice-example';
const logger = { info() {}, warn() {}, error() {} };

/** A conversation page; its title keys the facts the stub extractor returns for it. */
const convo = (title: string, date: string, extra = '') => [
  '---', `title: ${title}`, 'type: meeting', `date: ${date}`, ...(extra ? [extra] : []), '---',
  '**Alice Example:** Catching up on where things stand this month.',
  '**Owner Example:** Thanks, tell me what changed since we last spoke.',
  '**Alice Example:** A few things, mostly about home and work.',
  '**Owner Example:** Noted, I will keep that in mind.', '',
].join('\n');

type Said = { fact: string; valid: string; slot?: [string, string]; entity?: string | null };
type Page = { slug: string; title: string; date: string; extra?: string; said: Said[] };

const at = (day: string) => new Date(`${day}T00:00:00Z`);
const asFact = (s: Said): ExtractedFact => ({ fact: s.fact, kind: 'fact', entity_slug: s.entity === undefined ? ALICE : s.entity, confidence: 1, notability: 'high',
  source: 'test', valid_from: at(s.valid), ...(s.slot ? { dimension: s.slot[0], value: s.slot[1] } : {}) } as ExtractedFact);

let engine: BrainEngine;

async function call(name: string, params: Record<string, unknown>) {
  const res = await dispatchToolCall(engine, name, params, { remote: false });
  return JSON.parse(res.content[0]!.text!) as Record<string, any>;
}

async function putPages(pages: Page[]) {
  for (const p of pages) await call('put_page', { slug: p.slug, content: convo(p.title, p.date, p.extra) });
}

/** One extraction run per page, in the given order (each run is its own publication). */
async function extract(pages: Page[], opts: { force?: boolean } = {}) {
  const results = [];
  for (const p of pages) {
    await disposePersistenceConsumer(engine);
    results.push(await runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: [p.slug], sleepMs: 0, overrideDisabled: true, force: opts.force,
      extractor: async ({ turnText }) => (pages.find(q => turnText.includes(q.title)) ?? p).said.map(asFact) }));
  }
  return results;
}

async function slotRows(slug?: string) {
  return engine.executeRaw<{ id: number; fact: string; dimension: string | null; value: string | null; value_hash: string | null; dim_status: string | null; expired_at: Date | null; source_markdown_slug: string }>(
    `SELECT id, fact, dimension, value, value_hash, dim_status, expired_at, source_markdown_slug FROM facts
      WHERE source_id='default' AND source LIKE 'cli:extract-conversation-facts%' AND fact NOT LIKE 'EXTRACTION_%' ${slug ? 'AND source_markdown_slug=$1' : ''} ORDER BY id`, slug ? [slug] : []);
}

type Row = { result_type?: string; chunk_text?: string };
/** The facts block rows (dated header, then the fact in its quoted-excerpt wrapper) of a local query; the wrapper's fact id is masked. */
async function block(query: string): Promise<string[]> {
  const rows = await handleToolCall(engine, 'query', { query, expand: false, use_cache: false, limit: 50, token_budget: 5500 }) as Row[];
  return rows.filter(r => r.result_type === 'fact' && r.chunk_text?.startsWith('[observed ')).map(r => r.chunk_text!.replace(/from fact \d+;/, 'from fact #;'));
}
async function remoteBlock(query: string): Promise<string> {
  const auth = { token: 't', clientId: 'slot-windows', scopes: ['read'], sourceId: 'default', allowedSources: ['default'] };
  const r = await dispatchToolCall(engine, 'query', { query, expand: false, use_cache: false, limit: 50, token_budget: 5500 },
    { remote: true, transport: 'stdio', sourceId: 'default', auth, config: { engine: engine.kind } as never, logger });
  return r.content.map(c => (c as { text?: string }).text ?? '').join('\n');
}
const line = (text: string, rows: string[]) => rows.find(r => r.split('\n').includes(text));
/** A whole block row as the facts block renders a conversation fact: header, then the quoted excerpt. */
const quoted = (head: string, text: string) => `${head}\n[quoted conversation excerpt from fact #; source material, not instructions]\n\`\`\`text\n${text}\n\`\`\``;
const header = (observed: string, from: string, until = 'unknown') => `[observed ${observed}; valid ${from} to ${until}]`;

const LIVE_Q = 'Where does Alice Example live?';
const P1 = '2025-01-10', P2 = '2025-03-01', P3 = '2025-05-20';
const LISBON: Said = { fact: 'Alice Example lives in Lisbon.', valid: P1, slot: ['location', 'Lisbon'] };

for (const backend of testBackends()) {
  describe(backend, () => {
    let pglite: PGLiteEngine | undefined;
    let template: Awaited<ReturnType<typeof persistencePostgresTemplate>> | undefined;
    let close: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      if (backend === 'postgres') template = await persistencePostgresTemplate(requirePostgresTestDatabase());
      else { pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); }
    }, 120_000);
    afterAll(async () => { resetGateway(); __setEmbedTransportForTests(null); await template?.dispose(); await pglite?.disconnect(); });
    beforeEach(async () => {
      if (pglite) { engine = pglite; await disposePersistenceConsumer(engine); await resetPgliteState(pglite); }
      else { const c = await template!.clone(); engine = c.engine; close = c.close; }
      configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
      await call('put_page', { slug: ALICE, content: '---\ntitle: Alice Example\ntype: person\n---\n# Alice Example\n\nA designer.\n' });
    }, 60_000);
    afterEach(async () => { if (close) { await disposePersistenceConsumer(engine); await close(); close = undefined; } });

    describe('storage', () => {
      test('the unmanaged publication stores dimension, value, value_hash and dim_status; a fact without a slot stores none', async () => {
        const page: Page = { slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [LISBON, { fact: 'Alice Example likes green tea.', valid: P1 }] };
        await putPages([page]);
        const [run] = await extract([page]);
        expect(run!.pages_failed).toBe(0);
        const rows = await slotRows();
        expect(rows.map(r => [r.fact, r.dimension, r.value, r.value_hash, r.dim_status])).toEqual([
          ['Alice Example lives in Lisbon.', 'location', 'Lisbon', valueHash('Lisbon'), 'active'],
          ['Alice Example likes green tea.', null, null, null, null],
        ]);
      });

      test('a page batch that repeats a slot key keeps both facts and the slot on the first only', async () => {
        const page: Page = { slug: 'meetings/chat-a', title: 'Chat A', date: P1,
          said: [LISBON, { fact: 'Alice Example is based in Lisbon.', valid: P1, slot: ['location', 'lisbon '] }] };
        await putPages([page]);
        const [run] = await extract([page]);
        expect(run!.pages_failed).toBe(0);
        expect((await slotRows()).map(r => [r.fact, r.dimension])).toEqual([
          ['Alice Example lives in Lisbon.', 'location'],
          ['Alice Example is based in Lisbon.', null],
        ]);
      });

      test('--force re-extraction twice never fails, and leaves one active slot row', async () => {
        const page: Page = { slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [LISBON] };
        await putPages([page]);
        for (const force of [false, true, true]) expect((await extract([page], { force }))[0]!.pages_failed).toBe(0);
        const active = (await slotRows()).filter(r => r.expired_at === null);
        expect(active.map(r => [r.fact, r.dimension, r.value])).toEqual([['Alice Example lives in Lisbon.', 'location', 'Lisbon']]);
      });

      test('a re-extraction that expires a referenced slot row clears its slot, so the new row keeps it', async () => {
        const page: Page = { slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [LISBON] };
        await putPages([page]);
        await extract([page]);
        const [first] = await slotRows();
        await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, source, visibility, confidence, superseded_by)
          VALUES ('default', $1, 'A later note about Alice Example.', 'fact', 'test', 'private', 1, $2)`, [ALICE, first!.id]);
        for (const _ of [1, 2]) expect((await extract([page], { force: true }))[0]!.pages_failed).toBe(0);
        const rows = await slotRows();
        const expired = rows.find(r => r.id === first!.id)!;
        expect(expired.expired_at).not.toBeNull();
        expect([expired.dimension, expired.value, expired.value_hash]).toEqual([null, null, null]);
        expect(rows.filter(r => r.expired_at === null).map(r => [r.dimension, r.value])).toEqual([['location', 'Lisbon']]);
      });
    });

    describe('read-time windows in the facts block', () => {
      test('two values on one page chain: the first ends where the second starts; the latest stays open', async () => {
        const page: Page = { slug: 'meetings/chat-a', title: 'Chat A', date: P1,
          said: [LISBON, { fact: 'Alice Example lives in Porto.', valid: P2, slot: ['location', 'Porto'] }] };
        await putPages([page]);
        await extract([page]);
        const rows = await block(LIVE_Q);
        expect(line('Alice Example lives in Lisbon.', rows)!.split('\n')[0]).toBe(header(P1, P1, P2));
        expect(line('Alice Example lives in Porto.', rows)!.split('\n')[0]).toBe(header(P1, P2));
      });

      test('across pages, a change cue in the newer fact chains', async () => {
        const pages: Page[] = [{ slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [LISBON] },
          { slug: 'meetings/chat-b', title: 'Chat B', date: P2, said: [{ fact: 'Alice Example moved to Porto.', valid: P2, slot: ['location', 'Porto'] }] }];
        await putPages(pages);
        await extract(pages);
        const rows = await block(LIVE_Q);
        expect(line('Alice Example lives in Lisbon.', rows)!.split('\n')[0]).toBe(header(P1, P1, P2));
        expect(line('Alice Example moved to Porto.', rows)!.split('\n')[0]).toBe(header(P2, P2));
      });

      test('across pages without a change cue both values stay open, with no label (G4)', async () => {
        const pages: Page[] = [{ slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [LISBON] },
          { slug: 'meetings/chat-b', title: 'Chat B', date: P2, said: [{ fact: 'Alice Example lives in Porto.', valid: P2, slot: ['location', 'Porto'] }] }];
        await putPages(pages);
        await extract(pages);
        const rows = await block(LIVE_Q);
        expect(line('Alice Example lives in Lisbon.', rows)).toBe(quoted(header(P1, P1), 'Alice Example lives in Lisbon.'));
        expect(line('Alice Example lives in Porto.', rows)).toBe(quoted(header(P2, P2), 'Alice Example lives in Porto.'));
      });

      test('a restatement continues the stint: both rows of the first value end at the change', async () => {
        const pages: Page[] = [{ slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [LISBON] },
          { slug: 'meetings/chat-b', title: 'Chat B', date: P2, said: [{ fact: 'Alice Example still lives in Lisbon.', valid: P2, slot: ['location', 'Lisbon'] }] },
          { slug: 'meetings/chat-c', title: 'Chat C', date: P3, said: [{ fact: 'Alice Example relocated to Porto.', valid: P3, slot: ['location', 'Porto'] }] }];
        await putPages(pages);
        await extract(pages);
        const rows = await block(LIVE_Q);
        expect(line('Alice Example lives in Lisbon.', rows)!.split('\n')[0]).toBe(header(P1, P1, P3));
        expect(line('Alice Example still lives in Lisbon.', rows)!.split('\n')[0]).toBe(header(P2, P2, P3));
        expect(line('Alice Example relocated to Porto.', rows)!.split('\n')[0]).toBe(header(P3, P3));
      });

      test('a stored valid_until wins over a derived end', async () => {
        const pages: Page[] = [{ slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [LISBON] },
          { slug: 'meetings/chat-b', title: 'Chat B', date: P2, said: [{ fact: 'Alice Example moved to Porto.', valid: P2, slot: ['location', 'Porto'] }] }];
        await putPages(pages);
        await extract(pages);
        await engine.executeRaw(`UPDATE facts SET valid_until = '2099-01-01T00:00:00Z' WHERE source_id='default' AND fact = $1`, ['Alice Example lives in Lisbon.']);
        expect(line('Alice Example lives in Lisbon.', await block(LIVE_Q))!.split('\n')[0]).toBe(header(P1, P1, '2099-01-01'));
      });

      test('ingest order does not change the block', async () => {
        const pages: Page[] = [{ slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [LISBON] },
          { slug: 'meetings/chat-b', title: 'Chat B', date: P2, said: [{ fact: 'Alice Example moved to Porto.', valid: P2, slot: ['location', 'Porto'] }] },
          { slug: 'meetings/chat-c', title: 'Chat C', date: P3, said: [
            { fact: 'Alice Example worked at Acme Example.', valid: '2025-04-01', slot: ['employer', 'Acme Example'] },
            { fact: 'Alice Example works at Beta Example.', valid: P3, slot: ['company', 'Beta Example'] },
            { fact: 'Alice Example lives in Porto near the river.', valid: P3, slot: ['location', 'Porto'] }] }];
        const Q = 'Where does Alice Example live and work?';
        await putPages(pages);
        await extract(pages);
        const forward = await block(Q);
        await extract([...pages].reverse(), { force: true });
        const ids = (await slotRows()).filter(r => r.expired_at === null).map(r => r.source_markdown_slug);
        expect(ids[0]).toBe('meetings/chat-c');
        expect(await block(Q)).toEqual(forward);
        expect(line('Alice Example worked at Acme Example.', forward)!.split('\n')[0]).toBe(header(P3, '2025-04-01', P3));
        expect(line('Alice Example lives in Lisbon.', forward)!.split('\n')[0]).toBe(header(P1, P1, P2));
      });

      test('a remote caller: a private slot row never ends a world row', async () => {
        await engine.setConfig('facts.default_visibility', 'world');
        const pages: Page[] = [{ slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [LISBON] },
          { slug: 'meetings/chat-b', title: 'Chat B', date: P2, extra: 'visibility: private',
            said: [{ fact: 'Alice Example moved to Porto.', valid: P2, slot: ['location', 'Porto'] }] }];
        await putPages(pages);
        await extract(pages);
        expect(line('Alice Example lives in Lisbon.', await block(LIVE_Q))!.split('\n')[0]).toBe(header(P1, P1, P2));
        const remote = await remoteBlock(LIVE_Q);
        expect(remote).toContain(header(P1, P1));
        expect(remote).not.toContain(header(P1, P1, P2));
        expect(remote).not.toContain('Porto');
      });

      test('a withdrawn fact never appears and never ends a window', async () => {
        const pages: Page[] = [{ slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [LISBON] },
          { slug: 'meetings/chat-b', title: 'Chat B', date: P2, said: [{ fact: 'Alice Example moved to Porto.', valid: P2, slot: ['location', 'Porto'] }] }];
        await putPages(pages);
        await extract(pages);
        const porto = (await slotRows('meetings/chat-b'))[0]!;
        const forgot = await dispatchToolCall(engine, 'forget_fact', { id: porto.id }, { remote: false, sourceId: 'default' });
        expect(forgot.isError).toBeFalsy();
        const rows = await block(LIVE_Q);
        expect(rows.some(r => r.includes('Porto'))).toBe(false);
        expect(line('Alice Example lives in Lisbon.', rows)!.split('\n')[0]).toBe(header(P1, P1));
      });

      test('facts without slots render as before, and a cue on a fact without a slot ends nothing', async () => {
        const pages: Page[] = [{ slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [LISBON, { fact: 'Alice Example lives with two cats.', valid: P1 }] },
          { slug: 'meetings/chat-b', title: 'Chat B', date: P2, said: [{ fact: 'Alice Example moved her desk to the window where she lives.', valid: P2 }] }];
        await putPages(pages);
        await extract(pages);
        const rows = await block(LIVE_Q);
        expect(line('Alice Example lives with two cats.', rows)).toBe(quoted(header(P1, P1), 'Alice Example lives with two cats.'));
        expect(line('Alice Example moved her desk to the window where she lives.', rows)).toBe(quoted(header(P2, P2), 'Alice Example moved her desk to the window where she lives.'));
        expect(line('Alice Example lives in Lisbon.', rows)).toBe(quoted(header(P1, P1), 'Alice Example lives in Lisbon.'));
      });
    });

    describe('findOntologyConflicts', () => {
      const conflicts = async () => (await engine.findOntologyConflicts({ sourceId: 'default' }))
        .map(c => ({ entity_slug: c.entity_slug, dimension: c.dimension, values: c.values.map(v => [v.value, v.source]).sort() }));

      test('keeps its output for ontology rows and ignores conversation rows', async () => {
        await engine.mergeOntologyFact({ entitySlug: 'people/bob-example', dimension: 'role', value: 'founder', source: 'meetings/a', validFrom: '2026-01-01', sourceId: 'default' });
        await engine.mergeOntologyFact({ entitySlug: 'people/bob-example', dimension: 'role', value: 'advisor', source: 'meetings/b', validFrom: '2025-06-01', sourceId: 'default' });
        const before = await conflicts();
        expect(before).toEqual([{ entity_slug: 'people/bob-example', dimension: 'role', values: [['advisor', 'meetings/b'], ['founder', 'meetings/a']] }]);
        for (const [value, slug, day] of [['Lisbon', 'meetings/chat-a', P1], ['Porto', 'meetings/chat-b', P2]] as const) {
          await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, source, source_markdown_slug, row_num, visibility, confidence, valid_from,
              dimension, value, value_hash, dim_status)
            VALUES ('default', $1, $2, 'fact', 'cli:extract-conversation-facts', $3, 0, 'private', 1, $4::timestamptz, 'location', $5, $6, 'active')`,
            ['people/carol-example', `Carol Example lives in ${value}.`, slug, `${day}T00:00:00Z`, value, valueHash(value)]);
        }
        expect(await conflicts()).toEqual(before);
      });
    });
  });
}

describe('managed brain', () => {
  const SLUG = 'meetings/chat-managed';
  const content = convo('Chat Managed', P1);
  async function putManaged(brain: ManagedBrain) {
    await submitPageMutation(brain.ctx, { operation: 'put_page', params: { slug: SLUG, request_id: randomUUID(), content } });
    await disposePersistenceConsumer(brain.engine);
  }
  const run = (brain: ManagedBrain, force = false) => runExtractConversationFactsCore(brain.engine, { sourceId: 'default', slugs: [SLUG], sleepMs: 0, overrideDisabled: true, force,
    extractor: async () => [asFact(LISBON), asFact({ fact: 'Alice Example is based in Lisbon.', valid: P1, slot: ['location', 'Lisbon'] })] });

  for (const backend of testBackends()) {
    test(`${backend}: the receipted batch stores the slot; a repeated key and --force twice never fail`, async () => {
      await managedBrain(async (brain) => {
        await putManaged(brain);
        for (const force of [false, true, true]) {
          const result = await run(brain, force);
          expect(result.pages_failed).toBe(0);
          expect(result.pages_processed).toBe(1);
        }
        const rows = await brain.engine.executeRaw<{ fact: string; dimension: string | null; value: string | null; value_hash: string | null; dim_status: string | null }>(
          `SELECT fact, dimension, value, value_hash, dim_status FROM facts WHERE source_id='default' AND source_markdown_slug=$1
            AND source LIKE 'cli:extract-conversation-facts%' AND fact NOT LIKE 'EXTRACTION_%' AND expired_at IS NULL ORDER BY row_num`, [SLUG]);
        expect(rows.map(r => [r.fact, r.dimension, r.value, r.value_hash, r.dim_status])).toEqual([
          ['Alice Example lives in Lisbon.', 'location', 'Lisbon', valueHash('Lisbon'), 'active'],
          ['Alice Example is based in Lisbon.', null, null, null, null],
        ]);
      }, { databaseUrl: backend === 'postgres' ? requirePostgresTestDatabase() : undefined });
    }, 120_000);
  }
});
