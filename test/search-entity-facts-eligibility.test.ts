/**
 * Saved facts from a quarantined page, and facts awaiting re-derivation
 * (needs_rederive), never surface on the entity-fact readers: search and
 * query's entity facts (search/entity-facts.ts, local and remote), the
 * trajectory read (find_trajectory, think), the entity card's fact count, a
 * pinned question's evidence (facts, takes and timeline), local CLI recall,
 * and the consolidate phase's candidates.
 * Fails when: one of those reads drops projectionEligibleSql (eligibility/sql.ts).
 * PGLite always, Postgres too when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { operations } from '../src/core/operations.ts';
import { QUARANTINE_KEY } from '../src/core/quarantine.ts';
import { buildEntityCard } from '../src/core/verbs/entity-card.ts';
import { retrieveEvidence } from '../src/core/questions/refresh.ts';
import type { PinRow } from '../src/core/questions/store.ts';
import { runRecall } from '../src/commands/recall.ts';
import { gbrainPath } from '../src/core/config.ts';
import { runPhaseConsolidate } from '../src/core/cycle/phases/consolidate.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-entity-facts-elig-'));
const env = { GBRAIN_HOME: home };
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

const ENTITY = 'people/alice-example';
const op = (name: string) => operations.find(o => o.name === name)!;
const page = (title: string, type: string, body: string) => `---\ntitle: ${title}\ntype: ${type}\n---\n\n${body}\n`;

interface Trio { visible: number; quarantined: number; rederive: number }
interface Seed extends Trio { superseded: Trio; take: number; hiddenTake: number; timeline: number; hiddenTimeline: number }
const seeds = new Map<BrainEngine, Seed>();

const SESSION = 'session-ledger';
const SUPERSEDED_ENTITY = 'people/bob-example';

async function insertFact(engine: BrainEngine, text: string, sourcePage: string | null, supersededBy: number | null = null): Promise<number> {
  const [row] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, source, visibility, valid_from, source_markdown_slug, source_session, superseded_by, expired_at)
     VALUES ('default', $1, $2, 'fact', 'test', 'world', now() - interval '1 day', $3, $4, $5::bigint, CASE WHEN $5::bigint IS NULL THEN NULL ELSE now() END) RETURNING id`,
    [supersededBy === null ? ENTITY : SUPERSEDED_ENTITY, text, sourcePage, supersededBy === null ? SESSION : null, supersededBy]);
  return Number(row!.id);
}
const markRederive = (engine: BrainEngine, table: string, id: number) => engine.executeRaw(
  `INSERT INTO needs_rederive (derived_table, derived_id, source_id, reason) VALUES ($1, $2, 'default', 'test')`, [table, String(id)]);

async function seed(engine: BrainEngine): Promise<Seed> {
  await importFromContent(engine, ENTITY, page('Alice Example', 'person', 'Alice Example runs the ledger guild.'), { noEmbed: true, sourceId: 'default' });
  await importFromContent(engine, 'notes/ledger-guild', page('Ledger guild', 'note', 'Minutes of the ledger guild.'), { noEmbed: true, sourceId: 'default' });
  await importFromContent(engine, 'notes/held-note', page('Held note', 'note', 'A note the content gate held.'), { noEmbed: true, sourceId: 'default' });
  await engine.executeRaw(`UPDATE pages SET frontmatter = COALESCE(frontmatter, '{}'::jsonb) || jsonb_build_object($1::text, '{"reason":"junk_pattern","detail":"test","assessed_at":"2026-10-07T00:00:00Z"}'::jsonb) WHERE source_id = 'default' AND slug = 'notes/held-note'`, [QUARANTINE_KEY]);
  const visible = await insertFact(engine, 'Chairs the ledger guild meetings', 'notes/ledger-guild');
  const quarantined = await insertFact(engine, 'Approved the vendor wire transfer', 'notes/held-note');
  const rederive = await insertFact(engine, 'Keeps the vault combination', null);
  await markRederive(engine, 'facts', rederive);
  const superseded = {
    visible: await insertFact(engine, 'Formerly chaired the ledger guild', 'notes/ledger-guild', visible),
    quarantined: await insertFact(engine, 'Formerly approved the vendor wire', 'notes/held-note', visible),
    rederive: await insertFact(engine, 'Formerly kept the vault combination', null, visible),
  };
  await markRederive(engine, 'facts', superseded.rederive);
  const [pageRow] = await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE source_id = 'default' AND slug = $1`, [ENTITY]);
  await engine.addTakesBatch([
    { page_id: Number(pageRow!.id), row_num: 1, claim: 'Alice will ship the ledger audit', kind: 'take', holder: 'world', weight: 0.7 },
    { page_id: Number(pageRow!.id), row_num: 2, claim: 'Alice derived a purged estimate', kind: 'take', holder: 'world', weight: 0.7 },
  ]);
  const takes = await engine.executeRaw<{ id: number; row_num: number }>('SELECT id, row_num FROM takes WHERE page_id = $1 ORDER BY row_num', [Number(pageRow!.id)]);
  await markRederive(engine, 'takes', Number(takes[1]!.id));
  await engine.addTimelineEntry(ENTITY, { date: '2026-09-01', summary: 'Alice joined the ledger guild' }, { sourceId: 'default' });
  await engine.addTimelineEntry(ENTITY, { date: '2026-09-02', summary: 'Alice summary derived from a purged input' }, { sourceId: 'default' });
  const timeline = await engine.executeRaw<{ id: number; summary: string }>(
    'SELECT t.id, t.summary FROM timeline_entries t JOIN pages p ON p.id = t.page_id WHERE p.id = $1 ORDER BY t.date', [Number(pageRow!.id)]);
  await markRederive(engine, 'timeline_entries', Number(timeline[1]!.id));
  return { visible, quarantined, rederive, superseded, take: Number(takes[0]!.id), hiddenTake: Number(takes[1]!.id), timeline: Number(timeline[0]!.id), hiddenTimeline: Number(timeline[1]!.id) };
}

beforeAll(async () => withEnv(env, async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const engine of engines) { await registerLocalWriter(engine, 'cli'); seeds.set(engine, await seed(engine)); }
}), 120_000);
afterAll(async () => { await engines[0]?.disconnect(); await closePostgres?.(); rmSync(home, { recursive: true, force: true }); });

function ctx(engine: BrainEngine, remote: boolean, sink: { meta?: Record<string, any> }): OperationContext {
  return { engine, config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote, sourceId: 'default',
    ...(remote ? { auth: { token: 't', clientId: 'c1', scopes: ['read'], sourceId: 'default' } } : {}),
    emitResponseMeta: (key: string, value: unknown) => { if (key === 'retrieval') sink.meta = value as Record<string, any>; },
  } as unknown as OperationContext;
}
const visibleOnly = (s: Trio) => ({ visible: true, quarantined: false, rederive: false, ids: [s.visible] });
const shape = (s: Trio, ids: number[]) => ({ visible: ids.includes(s.visible), quarantined: ids.includes(s.quarantined), rederive: ids.includes(s.rederive),
  ids: ids.filter(id => [s.visible, s.quarantined, s.rederive].includes(id)).sort((a, b) => a - b) });
async function cliRecallIds(engine: BrainEngine, args: string[]): Promise<number[]> {
  rmSync(gbrainPath('recall-cursors'), { recursive: true, force: true });
  let out = '';
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
  try { await runRecall(engine, [...args, '--json', '--source', 'default']); } finally { process.stdout.write = write; }
  const rows = JSON.parse(out) as { facts?: Array<{ id: number }> } | Array<{ id: number }>;
  return (Array.isArray(rows) ? rows : rows.facts ?? []).map(f => Number(f.id));
}

describe('entity facts hide quarantined-page and needs_rederive facts', () => {
  test('search and query entity facts, local and remote', async () => withEnv(env, async () => {
    const seen: unknown[] = [];
    for (const engine of engines) {
      const s = seeds.get(engine)!;
      for (const remote of [false, true]) {
        for (const name of ['search', 'query'] as const) {
          const sink: { meta?: Record<string, any> } = {};
          const rows = await op(name).handler(ctx(engine, remote, sink), { query: 'Alice Example', limit: 10 }) as Array<{ fact_id?: string }>;
          // query's facts arm may return a fact as a row of its own, and then saved_facts leaves it out.
          const ids = [...((sink.meta?.saved_facts ?? []) as Array<{ id: number }>).map(f => Number(f.id)), ...rows.flatMap(r => r.fact_id ? [Number(r.fact_id)] : [])];
          seen.push({ engine: engine.kind, remote, name, ...shape(s, ids) });
        }
      }
    }
    expect(seen).toEqual(engines.flatMap(engine => [false, true].flatMap(remote => (['search', 'query'] as const).map(name =>
      ({ engine: engine.kind, remote, name, ...visibleOnly(seeds.get(engine)!) })))));
  }), 120_000);

  test('search entity facts apply the caller trust floor, as saved_facts does', async () => withEnv(env, async () => {
    const seen: unknown[] = [];
    for (const engine of engines) {
      const sink: { meta?: Record<string, any> } = {};
      await op('search').handler(ctx(engine, true, sink), { query: 'Alice Example', limit: 10, min_trust: 'operator_curated' });
      const [tier] = await engine.executeRaw<{ trust_tier: string }>('SELECT trust_tier FROM facts WHERE id = $1', [seeds.get(engine)!.visible]);
      seen.push({ engine: engine.kind, tier: tier!.trust_tier, saved_facts: ((sink.meta?.saved_facts ?? []) as Array<{ id: number }>).map(f => Number(f.id)) });
    }
    expect(seen).toEqual(engines.map(engine => ({ engine: engine.kind, tier: 'unknown', saved_facts: [] })));
  }), 120_000);

  test('trajectory, entity card count and local CLI recall', async () => withEnv(env, async () => {
    const seen: unknown[] = [];
    for (const engine of engines) {
      const s = seeds.get(engine)!;
      for (const remote of [false, true]) {
        const points = await engine.findTrajectory({ entitySlug: ENTITY, sourceId: 'default', remote, kind: 'all', limit: 100 });
        seen.push({ engine: engine.kind, remote, read: 'trajectory', ...shape(s, points.map(p => p.fact_id)) });
        const card = await buildEntityCard(engine, 'default', ENTITY, { remote });
        seen.push({ engine: engine.kind, remote, read: 'card', count: card.card?.active_fact_count ?? null });
      }
      seen.push({ engine: engine.kind, remote: false, read: 'cli_recall', ...shape(s, await cliRecallIds(engine, [ENTITY])) });
    }
    expect(seen).toEqual(engines.flatMap(engine => [
      ...[false, true].flatMap(remote => [
        { engine: engine.kind, remote, read: 'trajectory', ...visibleOnly(seeds.get(engine)!) },
        { engine: engine.kind, remote, read: 'card', count: 1 },
      ]),
      { engine: engine.kind, remote: false, read: 'cli_recall', ...visibleOnly(seeds.get(engine)!) },
    ]));
  }), 120_000);

  test('every other local CLI recall arm', async () => withEnv(env, async () => {
    const arms: Array<[arm: string, args: string[]]> = [
      ['--since-last-run cursor page', ['--since-last-run']],
      ['--supersessions', ['--supersessions']],
      ['entity with --since', [ENTITY, '--since', '7 days ago']],
      ['entity text fallback', ['the']],
      ['--session with --since', ['--session', SESSION, '--since', '7 days ago']],
      ['--session', ['--session', SESSION]],
      ['--since', ['--since', '7 days ago']],
      ['no filter', []],
    ];
    const trio = (s: Seed, arm: string) => arm === '--supersessions' ? s.superseded : s;
    const seen: unknown[] = [];
    for (const engine of engines) {
      for (const [arm, args] of arms) seen.push({ engine: engine.kind, arm, ...shape(trio(seeds.get(engine)!, arm), await cliRecallIds(engine, args)) });
    }
    expect(seen).toEqual(engines.flatMap(engine => arms.map(([arm]) => ({ engine: engine.kind, arm, ...visibleOnly(trio(seeds.get(engine)!, arm)) }))));
  }), 120_000);

  test('a pinned question gathers no hidden fact, take or timeline row as evidence', async () => withEnv(env, async () => {
    const seen: unknown[] = [];
    for (const engine of engines) {
      const s = seeds.get(engine)!;
      const pin = { source_id: 'default', slug: 'questions/alice-example', question: 'What does Alice Example do in the ledger guild?', scope_entity: ENTITY, scope_slug_prefix: null } as unknown as PinRow;
      const items = await retrieveEvidence(engine, pin);
      const of = (kind: string) => items.filter(i => i.kind === kind).map(i => Number(i.item_id)).sort((a, b) => a - b);
      seen.push({ engine: engine.kind, facts: shape(s, of('fact')), takes: of('take'), timeline: of('timeline') });
    }
    expect(seen).toEqual(engines.map(engine => {
      const s = seeds.get(engine)!;
      return { engine: engine.kind, facts: visibleOnly(s), takes: [s.take], timeline: [s.timeline] };
    }));
  }), 120_000);
});

describe('consolidate never promotes a hidden fact into a take', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { ...process.env } });
    engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); resetGateway(); });

  test('quarantined-page and needs_rederive facts stay unconsolidated (PGLite)', async () => withEnv(env, async () => {
    await engine.executeRaw(`INSERT INTO pages (slug, type, title) VALUES ($1, 'person', 'Alice Example'), ('notes/held-note', 'note', 'Held')`, [ENTITY]);
    await engine.executeRaw(`UPDATE pages SET frontmatter = jsonb_build_object($1::text, '{"reason":"junk_pattern","detail":"test","assessed_at":"2026-10-07T00:00:00Z"}'::jsonb) WHERE slug = 'notes/held-note'`, [QUARANTINE_KEY]);
    const vec = '[' + Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)).join(',') + ']';
    const ids: number[] = [];
    for (const [word, sourcePage] of [['alpha', null], ['beta', null], ['gamma', null], ['delta', 'notes/held-note'], ['epsilon', null]] as const) {
      const [row] = await engine.executeRaw<{ id: number }>(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from, confidence, embedding, embedded_at, embedding_model, embedded_text_hash, source_markdown_slug)
         VALUES ('default', $1, $2, 'fact', 'test', now() - interval '30 hours', 0.9, $3::vector, now() - interval '30 hours', 'openai:text-embedding-3-large', md5($2), $4) RETURNING id`,
        [ENTITY, `alice fact ${word}`, vec, sourcePage]);
      ids.push(Number(row!.id));
    }
    await markRederive(engine, 'facts', ids[4]!);
    await runPhaseConsolidate(engine, {});
    const rows = await engine.executeRaw<{ id: number; consolidated_at: Date | null }>('SELECT id, consolidated_at FROM facts ORDER BY id');
    expect(rows.map(r => ({ id: Number(r.id), consolidated: r.consolidated_at !== null })))
      .toEqual(ids.map((id, i) => ({ id, consolidated: i < 3 })));
  }), 120_000);
});
