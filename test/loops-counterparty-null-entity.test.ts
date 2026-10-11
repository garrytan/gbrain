/**
 * #5504 (wave 14 P4.1): a loop's counterparty page may live in another
 * source than the loop. On a federated brain the Gmail source carries the
 * thread pages while `people/<slug>` lives in `default`.
 *
 * (a) A counterparty nothing resolves with confidence leaves the loop row
 *     with a NULL slug and a NULL counterparty source, fabricates no page in
 *     any source and writes no edge.
 * (b) The resolver (google/counterparty.ts) crosses a source boundary by
 *     identity only: an exact-email alias in exactly one other source, or an
 *     entity_identities canonical member. A display name never crosses, a tie
 *     stays unresolved. Both writers stamp `counterparty_source_id`, the
 *     typed edge points at the page's source, and every reader confines on
 *     (slug, counterparty source): the entity card in `default` shows the
 *     Gmail loop, a namesake page in the Gmail source does not inherit it.
 *
 * Runs on PGLite and, with DATABASE_URL, on an isolated Postgres database
 * (test/e2e/loops-counterparty-null-entity-postgres.test.ts registers the
 * Postgres arm; the E2E matrix adds the PgBouncer transaction-mode pass).
 * Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { runLoopsExtract } from '../src/core/google/loops-extract.ts';
import { applyThreadLoopVerdict } from '../src/core/google/loop-detect.ts';
import { resolveCounterparty } from '../src/core/google/counterparty.ts';
import { listOpenLoops } from '../src/core/loops/loops-store.ts';
import { buildEntityCard } from '../src/core/verbs/entity-card.ts';
import { loopsOperations } from '../src/core/ops/loops.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { GmailThreadData } from '../src/core/google/types.ts';
import { normalizeAlias } from '../src/core/search/alias-normalize.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const G1 = 'g1';
const OTHER = 'other';
const engines: Array<{ engine: BrainEngine; close: () => Promise<void> }> = [];
const usage = { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 };

async function seed(engine: BrainEngine): Promise<void> {
  for (const id of [G1, OTHER]) {
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{"kind":"google"}'::jsonb) ON CONFLICT (id) DO NOTHING`, [id]);
  }
  const person = (title: string) => ({ type: 'person', title, compiled_truth: `# ${title}\n` });
  const alias = (sourceId: string, raw: string, slug: string) =>
    engine.executeRaw(`INSERT INTO page_aliases (source_id, alias_norm, slug) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [sourceId, normalizeAlias(raw), slug]);
  // Alice: page and email alias in default only (the federated-brain case).
  await engine.putPage('people/alice-example', person('Alice Example'), { sourceId: 'default' });
  await alias('default', 'alice@example.invalid', 'people/alice-example');
  await alias('default', 'Alice Example', 'people/alice-example');
  // A namesake slug in the Gmail source: a stub that must not inherit Alice's loops.
  await engine.putPage('people/alice-example', { ...person('Alice (stub)'), frontmatter: { google_contact_id: 'c1' } }, { sourceId: OTHER });
  // Bob: name alias in default, no email alias anywhere (names never cross).
  await engine.putPage('people/bob-example', person('Bob Example'), { sourceId: 'default' });
  await alias('default', 'Bob Example', 'people/bob-example');
  // Carol: email alias in two other sources (a tie).
  await engine.putPage('people/carol-example', person('Carol Example'), { sourceId: 'default' });
  await engine.putPage('people/carol-example', person('Carol Example'), { sourceId: OTHER });
  await alias('default', 'carol@example.invalid', 'people/carol-example');
  await alias(OTHER, 'carol@example.invalid', 'people/carol-example');
  // Dave: connector stub in g1 with its alias, identity group canonical in default.
  await engine.putPage('people/dave-stub', person('Dave Example'), { sourceId: G1 });
  await alias(G1, 'Dave Example', 'people/dave-stub');
  await engine.putPage('people/dave-example', person('Dave Example'), { sourceId: 'default' });
  const ids = await engine.executeRaw<{ id: number; source_id: string }>(
    `SELECT id, source_id FROM pages WHERE slug IN ('people/dave-stub', 'people/dave-example') AND source_id IN ($1, 'default')`, [G1]);
  for (const r of ids) {
    await engine.executeRaw(`INSERT INTO entity_identities (entity_id, source_id, page_id, canonical) VALUES ('ent-dave', $1, $2, $3)`,
      [r.source_id, r.id, r.source_id === 'default']);
  }
  // Erin: resolvable in the Gmail source itself.
  await engine.putPage('people/erin-example', person('Erin Example'), { sourceId: G1 });
  await alias(G1, 'erin@example.invalid', 'people/erin-example');
}

beforeAll(async () => {
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
  for (const backend of testBackends()) {
    if (backend === 'pglite') {
      const engine = new PGLiteEngine();
      await engine.connect({ database_url: '' });
      await engine.initSchema();
      engines.push({ engine, close: () => engine.disconnect() });
    } else {
      engines.push(await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    }
  }
  for (const { engine } of engines) await seed(engine);
}, 120_000);

afterAll(async () => {
  __setChatTransportForTests(null);
  resetGateway();
  for (const e of engines) await e.close();
});

function chatReturns(commitments: Array<Record<string, unknown>>): void {
  __setChatTransportForTests(async (): Promise<ChatResult> => ({
    text: JSON.stringify({ commitments, decisions_pending: [] }), blocks: [], stopReason: 'end', usage,
    model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic',
  }));
}

async function emailPage(engine: BrainEngine, slug: string, threadId: string, from: string, body: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'email', title: `Re: ${threadId}`, compiled_truth: `From: ${from}\n\n${body}\n`,
    frontmatter: { thread_id: threadId, date: '2026-09-20T10:00:00Z', from },
    effective_date: new Date('2026-09-20T10:00:00Z'),
  }, { sourceId: G1 });
}

async function extract(engine: BrainEngine, slug: string, threadId: string, c: Record<string, unknown>) {
  await emailPage(engine, slug, threadId, String(c.counterparty_email || 'someone@example.invalid'), 'I will send you the deck by Friday.');
  chatReturns([{ direction: 'owed_by_me', text: `Send the deck (${threadId})`, due_iso: null, quote: 'I will send you the deck by Friday.', ...c }]);
  const r = await runLoopsExtract(engine, { slug, sourceId: G1 });
  expect(r).toMatchObject({ status: 'extracted', commitments: 1 });
  const [row] = await engine.executeRaw<{ counterparty_slug: string | null; counterparty_source_id: string | null }>(
    `SELECT counterparty_slug, counterparty_source_id FROM open_loops WHERE source_id = $1 AND thread_id = $2`, [G1, threadId]);
  return row;
}

async function edgesFrom(engine: BrainEngine, slug: string) {
  return engine.executeRaw<{ to_slug: string; to_source: string; link_type: string }>(
    `SELECT t.slug AS to_slug, t.source_id AS to_source, l.link_type FROM links l
       JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
      WHERE f.slug = $1 AND f.source_id = $2 AND l.link_source = 'google-loops'`, [slug, G1]);
}

describe('(a) an unresolvable counterparty', () => {
  test('writes a NULL-counterparty loop, no page in any source and no edge', async () => {
    for (const { engine } of engines) {
      const row = await extract(engine, 'emails/nobody', 'thread-nobody', { counterparty_name: 'Nobody Known', counterparty_email: 'nobody@nowhere.invalid' });
      expect(row).toEqual({ counterparty_slug: null, counterparty_source_id: null });
      const pages = await engine.executeRaw<{ slug: string }>(`SELECT slug FROM pages WHERE slug <> 'emails/nobody' AND (slug LIKE '%nobody%' OR slug LIKE '%known%') AND deleted_at IS NULL`);
      expect(pages).toEqual([]);
      expect(await edgesFrom(engine, 'emails/nobody')).toEqual([]);
    }
  }, 60_000);
});

describe('(b) resolver: identity-only cross-source matching', () => {
  test('own source first, then an exact-email alias in exactly one other source', async () => {
    for (const { engine } of engines) {
      expect(await resolveCounterparty(engine, G1, { name: 'Erin Example', email: 'erin@example.invalid' }))
        .toEqual({ slug: 'people/erin-example', sourceId: G1, via: 'same_source' });
      expect(await resolveCounterparty(engine, G1, { name: 'Alice Example', email: 'alice@example.invalid' }))
        .toEqual({ slug: 'people/alice-example', sourceId: 'default', via: 'email_alias' });
    }
  });

  test('a display name never crosses a source; a tie stays unresolved', async () => {
    for (const { engine } of engines) {
      expect(await resolveCounterparty(engine, G1, { name: 'Bob Example', email: 'bob@elsewhere.invalid' })).toBeNull();
      expect(await resolveCounterparty(engine, G1, { name: 'Bob Example' })).toBeNull();
      expect(await resolveCounterparty(engine, G1, { name: 'Carol Example', email: 'carol@example.invalid' })).toBeNull();
    }
  });

  test('an entity_identities canonical member in another source wins over the local stub', async () => {
    for (const { engine } of engines) {
      expect(await resolveCounterparty(engine, G1, { name: 'Dave Example', email: 'dave@example.invalid' }))
        .toEqual({ slug: 'people/dave-example', sourceId: 'default', via: 'identity_canonical' });
    }
  });
});

describe('(b) writers stamp counterparty_source_id', () => {
  test('loops_extract: the row names the page source and the owes_to edge points there', async () => {
    for (const { engine } of engines) {
      const row = await extract(engine, 'emails/alice', 'thread-alice', { counterparty_name: 'Alice Example', counterparty_email: 'alice@example.invalid' });
      expect(row).toEqual({ counterparty_slug: 'people/alice-example', counterparty_source_id: 'default' });
      expect(await edgesFrom(engine, 'emails/alice')).toEqual([{ to_slug: 'people/alice-example', to_source: 'default', link_type: 'owes_to' }]);
      const same = await extract(engine, 'emails/erin', 'thread-erin', { counterparty_name: 'Erin Example', counterparty_email: 'erin@example.invalid' });
      expect(same).toEqual({ counterparty_slug: 'people/erin-example', counterparty_source_id: G1 });
    }
  }, 60_000);

  test('deterministic detector: an unanswered inbound from Alice resolves across sources', async () => {
    for (const { engine } of engines) {
      const thread: GmailThreadData = {
        threadId: 'thread-alice-inbound', account: 'me@example.invalid',
        messages: [{
          id: 'm1', threadId: 'thread-alice-inbound', from: 'Alice Example <alice@example.invalid>', fromAddress: 'alice@example.invalid',
          to: ['me@example.invalid'], cc: [], subject: 'Quarterly plan', bodyText: 'Can you review the plan?', dateIso: '2026-09-10T10:00:00Z',
          internalDateMs: Date.parse('2026-09-10T10:00:00Z'), labelIds: ['INBOX'], listUnsubscribe: false,
        }],
      };
      const verdict = await applyThreadLoopVerdict(engine, G1, thread, new Set(['me@example.invalid']), null, new Date('2026-09-20T10:00:00Z'));
      expect(verdict.open.map((s) => s.loopType)).toEqual(['unanswered_inbound']);
      const [row] = await engine.executeRaw<{ counterparty_slug: string | null; counterparty_source_id: string | null }>(
        `SELECT counterparty_slug, counterparty_source_id FROM open_loops WHERE source_id = $1 AND thread_id = $2`, [G1, 'thread-alice-inbound']);
      expect(row).toEqual({ counterparty_slug: 'people/alice-example', counterparty_source_id: 'default' });
    }
  }, 60_000);
});

describe('(b) readers confine on (slug, counterparty source)', () => {
  test("Alice's card in default shows the Gmail loops; the namesake stub in another source does not", async () => {
    for (const { engine } of engines) {
      const card = await buildEntityCard(engine, 'default', 'people/alice-example', { remote: false });
      expect(card.found).toBe(true);
      const threads = (card.card!.open_threads ?? []).filter((t) => t.loop_id !== undefined);
      expect(threads.map((t) => t.direction).sort()).toEqual(['my_turn', 'owed_by_me']);
      const stub = await buildEntityCard(engine, OTHER, 'people/alice-example', { remote: false });
      expect(stub.found).toBe(true);
      expect((stub.card!.open_threads ?? []).filter((t) => t.loop_id !== undefined)).toEqual([]);
    }
  });

  test('listOpenLoops counterpartySourceId filters the slug to one source', async () => {
    for (const { engine } of engines) {
      const inDefault = await listOpenLoops(engine, { sourceIds: [G1], status: 'open', counterparty: 'people/alice-example', counterpartySourceId: 'default' });
      expect(inDefault.map((l) => l.thread_id).sort()).toEqual(['thread-alice', 'thread-alice-inbound']);
      expect(inDefault.every((l) => l.counterparty_source_id === 'default')).toBe(true);
      const inOther = await listOpenLoops(engine, { sourceIds: [G1], status: 'open', counterparty: 'people/alice-example', counterpartySourceId: OTHER });
      expect(inOther).toEqual([]);
      // A pre-v234 row (NULL counterparty source) reads as its own source.
      const legacy = await listOpenLoops(engine, { sourceIds: [G1], status: 'open', counterparty: 'people/erin-example', counterpartySourceId: G1 });
      expect(legacy.map((l) => l.thread_id)).toEqual(['thread-erin']);
    }
  });

  test('open_loops groups carry counterparty_source_id and attach the card from that source', async () => {
    for (const { engine } of engines) {
      const op = loopsOperations.find((o) => o.name === 'open_loops')!;
      const ctx = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId: G1, remote: false, dryRun: false,
        logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
      const res = await op.handler(ctx, { group_by: 'counterparty', source_id: G1, limit: 50 }) as {
        groups: Array<{ counterparty_slug: string | null; source_id: string; counterparty_source_id: string; context?: { slug?: string } }>;
      };
      const alice = res.groups.find((g) => g.counterparty_slug === 'people/alice-example');
      expect(alice).toMatchObject({ source_id: G1, counterparty_source_id: 'default' });
      expect(alice?.context).toBeDefined();
      const erin = res.groups.find((g) => g.counterparty_slug === 'people/erin-example');
      expect(erin).toMatchObject({ source_id: G1, counterparty_source_id: G1 });
    }
  });
});
