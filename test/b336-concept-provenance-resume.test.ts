// Protects cached concept pages left durable before their provenance was banked.
// Regression: the unchanged-member shortcut returns without repairing either
// direction of the member links. Existing identity tests cover narrative reuse,
// but never start with a durable cached page whose provenance is incomplete.
// Uses the existing phase inputs and real isolated PGLite; no production seam.
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseSynthesizeConcepts } from '../src/core/cycle/synthesize-concepts.ts';
import { CONCEPT_FAILED_ATTEMPTS_KEY } from '../src/core/cycle/concept-retry-bound.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { writePageThrough, _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const SOURCE = 'scope-a';
const OTHER = 'scope-b';
const SLUG = 'concepts/orbit';
const MODEL = 'anthropic:claude-sonnet-4-6';
const BODY = 'Retained narrative.\n\n## Notes\nKeep the existing material.';
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 240000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await resetPgliteState(engine);
  await engine.setConfig('models.dream.synthesize', MODEL);
  await engine.setConfig('mentions.auto_link', 'false');
  _resetWriteThroughCacheForTest();
}, 120000);
afterEach(async () => { await disposePersistenceConsumer(engine); });

async function fixture(managed: boolean, n = 2, mode = 'deterministic_tier') {
  // Roots stay under the process's isolated TMPDIR for failure diagnosis;
  // the outer test runner owns their lifecycle, not a real brain directory.
  const root = mkdtempSync(join(tmpdir(), 'concept-provenance-resume-'));
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2),($3,$3,NULL)', [SOURCE, root, OTHER]);
  const atoms = Array.from({ length: n }, (_, i) => ({
    slug: `atoms/a${i}`, title: `A${i}`, body: `body ${i}`, concept_refs: ['orbit'], visibility: 'private' as const,
  }));
  for (const sourceId of [SOURCE, OTHER]) for (const atom of atoms) {
    await engine.putPage(atom.slug, { type: 'atom', title: atom.title, compiled_truth: atom.body,
      timeline: '', frontmatter: { concepts: atom.concept_refs, visibility: 'private' } }, { sourceId });
  }
  const memberHash = createHash('sha256').update(JSON.stringify([n < 3 ? '' : MODEL, 'private', atoms.map(a => [a.slug, a.title, a.body])])).digest('hex').slice(0, 16);
  const frontmatter = { synthesized_by: 'synthesize_concepts-v0.41', synthesis_mode: mode,
    member_hash: memberHash, synthesized_at: '2026-01-01T00:00:00.000Z', visibility: 'private',
    mention_count: n, owner_note: 'retain' };
  await engine.putPage(SLUG, { type: 'concept', title: 'orbit', compiled_truth: BODY,
    timeline: '2026-01-01 retained entry', frontmatter }, { sourceId: SOURCE });
  await engine.putPage(SLUG, { type: 'concept', title: 'foreign', compiled_truth: 'Foreign body.',
    timeline: '', frontmatter }, { sourceId: OTHER });
  const counters = JSON.stringify({ [`${SOURCE}:${SLUG}`]: { member_hash: memberHash, attempts: 2, at: '2026-01-01' } });
  await engine.setConfig(CONCEPT_FAILED_ATTEMPTS_KEY, counters);
  if (managed) {
    await claimWorktree(engine, SOURCE, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  }
  let calls = 0;
  const run = (dryRun = false) => runPhaseSynthesizeConcepts(engine, { sourceId: SOURCE, brainDir: root,
    _atoms: atoms, dryRun, _chat: async () => { calls++; throw new Error('model_must_not_run'); } });
  return { root, atoms, counters, run, calls: () => calls };
}

async function edges() {
  return engine.executeRaw<{ id: number; f: string; t: string; fs: string; ts: string; kind: string; context: string }>(
    `SELECT l.id,f.slug AS f,t.slug AS t,f.source_id AS fs,t.source_id AS ts,l.link_type AS kind,l.context
       FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
      WHERE l.link_source='concept-provenance' ORDER BY f.source_id,f.slug,t.source_id,t.slug,l.link_type`);
}

for (const managed of [false, true]) for (const [n, mode] of [[2, 'deterministic_tier'], [5, 'llm']] as const) {
  test(`${managed ? 'managed' : 'classic'} cached ${mode} repairs both directions without rewriting or spending`, async () => {
    const f = await fixture(managed, n, mode);
    const before = await engine.readPageSnapshot(SLUG, { sourceId: SOURCE });
    const other = await engine.readPageSnapshot(SLUG, { sourceId: OTHER });
    const result = await f.run();
    const linked = await edges();
    expect(linked).toHaveLength(n * 2);
    expect(linked.every(e => e.fs === SOURCE && e.ts === SOURCE)).toBe(true);
    for (const atom of f.atoms) {
      expect(linked.some(e => e.f === SLUG && e.t === atom.slug && e.kind === 'synthesized_from')).toBe(true);
      expect(linked.some(e => e.f === atom.slug && e.t === SLUG && e.kind === 'synthesizes')).toBe(true);
    }
    expect(result.status).toBe('ok');
    expect(result.details).toMatchObject({ concepts_written: 0, provenance_repaired: 1, provenance_links_added: n * 2, unchanged_concepts: 1 });
    expect(await engine.readPageSnapshot(SLUG, { sourceId: SOURCE })).toEqual(before);
    expect(await engine.readPageSnapshot(SLUG, { sourceId: OTHER })).toEqual(other);
    expect(await engine.getConfig(CONCEPT_FAILED_ATTEMPTS_KEY)).toBe(f.counters);
    expect(await engine.getConfig('mentions.auto_link')).toBe('false');
    expect(f.calls()).toBe(0);
    expect(await engine.executeRaw('SELECT id FROM persistence_requests')).toHaveLength(0);
    const again = await f.run();
    expect(await edges()).toEqual(linked);
    expect(again.details).toMatchObject({ concepts_written: 0, provenance_repaired: 0, provenance_links_added: 0 });
    expect(await engine.readPageSnapshot(SLUG, { sourceId: SOURCE })).toEqual(before);
    expect(await engine.getConfig(CONCEPT_FAILED_ATTEMPTS_KEY)).toBe(f.counters);
    expect(f.calls()).toBe(0);
  }, 120000);
}

test('missing reverse links are added while existing forward contexts survive', async () => {
  const f = await fixture(false);
  for (const atom of f.atoms) await engine.addLinksBatch([{ from_slug: SLUG, to_slug: atom.slug,
    from_source_id: SOURCE, to_source_id: SOURCE, link_type: 'synthesized_from',
    link_source: 'concept-provenance', context: 'retained edge context' }]);
  const prefix = await edges();
  const result = await f.run();
  const after = await edges();
  expect(after).toHaveLength(4);
  for (const old of prefix) expect(after).toContainEqual(old);
  expect(result.details).toMatchObject({ provenance_repaired: 1, provenance_links_added: 2 });
  expect(f.calls()).toBe(0);
}, 120000);

test('dry run leaves missing links, pages and retry counters untouched', async () => {
  const f = await fixture(false);
  const before = await engine.readPageSnapshot(SLUG, { sourceId: SOURCE });
  await f.run(true);
  expect(await edges()).toHaveLength(0);
  expect(await engine.readPageSnapshot(SLUG, { sourceId: SOURCE })).toEqual(before);
  expect(await engine.getConfig(CONCEPT_FAILED_ATTEMPTS_KEY)).toBe(f.counters);
  expect(f.calls()).toBe(0);
}, 120000);

test('human-owned concepts never get phase-owned provenance repair', async () => {
  const f = await fixture(false);
  await engine.executeRaw("UPDATE pages SET frontmatter=frontmatter-'synthesized_by' WHERE source_id=$1 AND slug=$2", [SOURCE, SLUG]);
  const before = await engine.readPageSnapshot(SLUG, { sourceId: SOURCE });
  await f.run();
  expect(await edges()).toHaveLength(0);
  expect(await engine.readPageSnapshot(SLUG, { sourceId: SOURCE })).toEqual(before);
  expect(f.calls()).toBe(0);
}, 120000);

test('a refused repair is a provenance warning without a model retry or page rewrite', async () => {
  const f = await fixture(false);
  const before = await engine.readPageSnapshot(SLUG, { sourceId: SOURCE });
  const failure = spyOn(engine, 'addLinksBatch').mockRejectedValue(new Error('fixture_write_refused'));
  try {
    const result = await f.run();
    expect(result.status).toBe('warn');
    expect(result.details.link_warnings).toHaveLength(1);
    expect(result.details.failures).toHaveLength(0);
    expect(await edges()).toHaveLength(0);
    expect(await engine.readPageSnapshot(SLUG, { sourceId: SOURCE })).toEqual(before);
    expect(await engine.getConfig(CONCEPT_FAILED_ATTEMPTS_KEY)).toBe(f.counters);
    expect(f.calls()).toBe(0);
  } finally { failure.mockRestore(); }
}, 120000);

test('an unimported canonical-file edit refuses link repair on the unchanged shortcut', async () => {
  const f = await fixture(false);
  await engine.setConfig('sync.write_through', 'true');
  const file = await writePageThrough(engine, SLUG, { sourceId: SOURCE });
  expect(file.written).toBe(true);
  const before = await engine.readPageSnapshot(SLUG, { sourceId: SOURCE });
  const edited = readFileSync(file.path!, 'utf8') + '\nUSER EDIT retained in file.\n';
  writeFileSync(file.path!, edited);
  const result = await f.run();
  expect(result.status).toBe('warn');
  expect(result.details.publication_deferred).toHaveLength(1);
  expect(await edges()).toHaveLength(0);
  expect(readFileSync(file.path!, 'utf8')).toBe(edited);
  expect(await engine.readPageSnapshot(SLUG, { sourceId: SOURCE })).toEqual(before);
  expect(f.calls()).toBe(0);
}, 120000);

test('a writer taking over the cached page before repair keeps its body and graph ownership', async () => {
  const f = await fixture(false);
  const original = engine.getLinks.bind(engine);
  let changed = false;
  const race = spyOn(engine, 'getLinks').mockImplementation(async (slug, opts) => {
    if (!changed && slug === SLUG && opts?.sourceId === SOURCE) {
      changed = true;
      await engine.putPage(SLUG, { type: 'concept', title: 'Human-owned', compiled_truth: 'New user narrative.',
        timeline: 'User timeline.', frontmatter: { owner: 'human' } }, { sourceId: SOURCE });
    }
    return original(slug, opts);
  });
  try {
    const result = await f.run();
    expect(result.status).toBe('warn');
    expect(result.details.publication_deferred).toHaveLength(1);
    expect(await edges()).toHaveLength(0);
    expect((await engine.getPage(SLUG, { sourceId: SOURCE }))?.compiled_truth).toBe('New user narrative.');
    expect(await engine.getConfig(CONCEPT_FAILED_ATTEMPTS_KEY)).toBe(f.counters);
    expect(f.calls()).toBe(0);
  } finally { race.mockRestore(); }
}, 120000);
