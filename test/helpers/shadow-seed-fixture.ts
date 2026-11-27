/**
 * Shared shadow-seed scenarios for test/shadow-seed.test.ts (PGLite) and test/e2e/shadow-seed.test.ts (Postgres):
 * the fixture rows, a seed into a new store, the read-parity check and the primary digests.
 */
import { expect } from 'bun:test';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { RustAddon } from '../../src/core/rust-engine/addon-loader.ts';
import { openRustStore } from '../../src/core/rust-engine/store.ts';
import { openRustEngine } from '../../src/core/rust-engine.ts';
import { digestTable } from '../../src/core/persistence/graduation-digest.ts';
import { runSeed, type SeedRecord } from '../../src/shadow/seed.ts';

export const SEED_FIXTURE_SLUGS = ['people/alice-example', 'companies/acme-example'] as const;

/** Two pages with a link, a tag, a timeline entry and a fact. */
export async function fillSeedFixture(engine: BrainEngine): Promise<void> {
  await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Alice runs the widget team.', timeline: '' });
  await engine.putPage('companies/acme-example', { type: 'company', title: 'Acme Example', compiled_truth: 'Acme makes widgets for everyone.', timeline: '' });
  await engine.addLink('people/alice-example', 'companies/acme-example', 'works at', 'works_at');
  await engine.addTag('people/alice-example', 'team');
  await engine.addTimelineEntry('people/alice-example', { date: '2026-03-01', source: 'meeting', summary: 'Alice joined Acme' });
  await engine.insertFact({ fact: 'Alice prefers async standups', entity_slug: 'people/alice-example', source: 'mcp:remember' }, { source_id: 'default' });
}

/** One waiting and one completed minion job: the seed counts one unfinished job and two not-copied rows. */
export async function insertSeedFixtureJobs(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO minion_jobs (submission_authority, name, status, queue)
     VALUES ('{"version":1,"kind":"application"}'::jsonb, 'sync', 'waiting', 'default'),
            ('{"version":1,"kind":"application"}'::jsonb, 'sync', 'completed', 'default')`);
}

/** Seeds a new store at `<dir>/store` from the primary and returns the record and the store path. */
export async function seedInto(primary: BrainEngine, addon: RustAddon, dir: string, primaryEngine: 'pglite' | 'postgres'):
  Promise<{ record: SeedRecord; storePath: string }> {
  const storePath = join(dir, 'store');
  const store = await openRustStore(addon, storePath);
  try {
    const record = await runSeed(primary, store, { primaryEngine, batchRows: 2 });
    return { record, storePath };
  } finally {
    await store.close();
  }
}

/** Opens the Rust engine on a seeded store and checks it answers the fixture reads as the primary does. */
export async function expectSeedReadParity(primary: BrainEngine, addon: RustAddon, storePath: string): Promise<void> {
  const rust = openRustEngine({ addon, databasePath: storePath });
  await rust.connect({ engine: 'pglite', database_path: storePath } as never);
  try {
    const pick = (p: { slug: string; title: string; type: string; compiled_truth: string } | null) =>
      p && { slug: p.slug, title: p.title, type: p.type, compiled_truth: p.compiled_truth };
    for (const slug of SEED_FIXTURE_SLUGS) {
      expect(pick(await rust.getPage(slug))).toEqual(pick(await primary.getPage(slug)));
      expect(await rust.getTags(slug)).toEqual(await primary.getTags(slug));
    }
    const links = (l: Array<{ from_slug: string; to_slug: string; link_type: string; context: string }>) =>
      l.map(x => ({ from: x.from_slug, to: x.to_slug, type: x.link_type, context: x.context }));
    expect(links(await rust.getLinks('people/alice-example'))).toEqual(links(await primary.getLinks('people/alice-example')));
    const timeline = (t: Array<{ date: unknown; summary: string; source: string }>) =>
      t.map(x => ({ date: dateText(x.date), summary: x.summary, source: x.source }));
    expect(timeline(await rust.getTimeline('people/alice-example'))).toEqual(timeline(await primary.getTimeline('people/alice-example')));
    const facts = (f: Array<{ id: number; fact: string; entity_slug: string | null }>) => f.map(x => ({ id: Number(x.id), fact: x.fact, entity: x.entity_slug }));
    expect(facts(await rust.listFactsByEntity('default', 'people/alice-example'))).toEqual(facts(await primary.listFactsByEntity('default', 'people/alice-example')));
    const hits = async (e: BrainEngine) => (await e.searchKeyword('widgets')).map(h => h.slug).sort();
    expect(await hits(rust as unknown as BrainEngine)).toEqual(await hits(primary));
    // The seed copies each page's generation as the primary holds it, and the next insert takes the highest plus one.
    const generations = async (e: BrainEngine) => ({
      pages: await Promise.all(SEED_FIXTURE_SLUGS.map(async slug => (await e.readQuestionPageRow('default', slug))?.generation ?? null)),
      clock: (await e.readQuestionEvidenceClock('default')).generation,
    });
    const seeded = await generations(rust as unknown as BrainEngine);
    expect(seeded).toEqual(await generations(primary));
    expect(seeded.clock).toBeGreaterThan(1);
    const next = { type: 'note' as const, title: 'After the seed', compiled_truth: 'Written after the seed.', timeline: '' };
    await primary.putPage('notes/after-the-seed', next);
    await rust.putPage('notes/after-the-seed', next);
    const inserted = async (e: BrainEngine) => (await e.readQuestionPageRow('default', 'notes/after-the-seed'))?.generation;
    expect(await inserted(rust as unknown as BrainEngine)).toBe(seeded.clock + 1);
    expect(await inserted(rust as unknown as BrainEngine)).toBe(await inserted(primary));
  } finally {
    await rust.disconnect();
  }
}

function dateText(d: unknown): string {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

const DIGEST_TABLES = ['pages', 'links', 'tags', 'timeline_entries', 'facts', 'content_chunks', 'config', 'sources'];

/** Root digests of the tables a seed reads: equal before and after means the seed wrote nothing to the primary. */
export async function primaryDigests(primary: BrainEngine): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const relation of DIGEST_TABLES) {
    out[relation] = (await digestTable(primary, { relation, transforms: [], rowFilter: null } as never)).rootSha256;
  }
  return out;
}

/**
 * Seeds the owner's allow rules (one active, one removed) from `primary` into a fresh Rust store and returns what each
 * engine lists: the same rules, ids and receipts on both. A store that does not copy `trust_allow_rules` lists none and
 * counts the rows as a gap.
 */
export async function seedAllowRules(primary: BrainEngine, addon: RustAddon, dir: string, primaryEngine: 'pglite' | 'postgres') {
  const add = (sourceId: string, uriPrefix: string, reasonFamily: string | null) =>
    primary.addTrustAllowRule({ sourceId, uriPrefix, reasonFamily, createdBy: 'local_cli:owner', reason: 'seed parity' });
  await add('default', 'https://feeds.example.com/', 'standing_instruction');
  const removed = await add('default', 'https://old.example.com/', null);
  await primary.removeTrustAllowRule(Number(removed.row!.id), 'local_cli:owner');
  const { record, storePath } = await seedInto(primary, addon, dir, primaryEngine);
  const rust = openRustEngine({ addon, databasePath: storePath });
  await rust.connect({ engine: 'pglite', database_path: storePath } as never);
  const view = (rows: Array<Record<string, unknown>>) => rows.map(r => ({
    id: Number(r.id), source_id: r.source_id, uri_prefix: r.uri_prefix, reason_family: r.reason_family, created_by: r.created_by,
    created_at: new Date(r.created_at as string | Date).toISOString(), removed_at: r.removed_at ? new Date(r.removed_at as string | Date).toISOString() : null,
    removed_by: r.removed_by, reason: r.reason,
  }));
  try {
    return {
      record,
      primary: view(await primary.listTrustAllowRuleRows({ includeRemoved: true })),
      rust: view(await rust.listTrustAllowRuleRows({ includeRemoved: true })),
      // The next add on the Rust brain takes the id after the seeded ones, as the primary's sequence would.
      next: Number((await rust.addTrustAllowRule({ sourceId: 'default', uriPrefix: 'https://new.example.com/', reasonFamily: null, createdBy: 'local_cli:owner', reason: null })).row!.id),
    };
  } finally {
    await rust.disconnect();
  }
}
