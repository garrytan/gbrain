/**
 * BrainEngine parity: the previews of `gbrain repair facts-home`, `visibility` and `open-facts`, and the named stops of
 * their reads and applies (batch 4.3a of the repair-on-Rust plan).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a brain seeded so each preview LISTS at least one item, the plan (apply:false) of facts-home on a strict
 *    source (facts that need no access read: an ontology observation, a fact of an entity with a page, with a deleted page,
 *    and a fact with no entity) and of visibility's facts class gives the same preview, hash, listing and residuals on PGLite,
 *    Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1). The members behind them (listFactsHomeCandidates,
 *    listHeldHomeRows, listOrphanedFenceRows, readFactSnapshots) answer the same rows on every arm.
 *  - Named stops, all on the Rust engine only (the SQL arms run the same call and list items): a fact of an entity with no
 *    page reaches the folder-access read (readHeldAccessState, a facts member the Rust engine does not serve), and the
 *    refusal surfaces as `engine_capability_missing` (facts), never as an `access_unreadable` classification; visibility's events, aliases,
 *    lineage and named-page classes stop at "repair visibility privacy scan" before any read; open-facts stops at "repair
 *    open-facts privacy scan" before its window and counts; the applies of facts-home and visibility stop at "repair
 *    facts-home page write" and "repair visibility page write" before their first write.
 *  - Regression: facts-home's scan read facts through `executeRaw` (and `readFacts` ran even for an empty list), so a Rust
 *    brain stopped at its first read; holdingPageFor turned any access-read error into `access_unreadable`, so a refusal
 *    became a folder-access classification. visibility and open-facts read through `executeRaw` before any stop.
 *  - Why existing coverage misses it: the repair tests for these kinds seed with raw SQL and run on PGLite or Postgres only.
 *  - Seam: none in a preview. Every page, fact and source is seeded through typed members; the strict source is a plain git
 *    checkout under a temp dir, claimed through the typed worktree members. Generated values (hashes, ids, the temp root) are
 *    compared by shape.
 */
import { describe, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { resolveRepairScope, type RepairKind, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';

const { parityTest } = parityArms(testBackends());

const quiet = { info() {}, warn() {}, error() {} } as never;

/** A result with every SHA-256 digest (a preview hash binds the brain id, drawn at random per brain), uuid and the temp root reduced to a marker. */
function shape(result: RepairResult, root?: string) {
  const { scope, ...rest } = result;
  let text = JSON.stringify({ ...rest, scope: { brain_id: typeof scope.brain_id, source_ids: scope.source_ids } })
    .replace(/\b[0-9a-f]{64}\b/g, '<sha256>').replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>');
  if (root) text = text.split(root).join('<root>');
  return JSON.parse(text);
}

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-previews3-home-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, () => fn(home));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

type RunOpts = Record<string, unknown>;
const runKind = async (engine: BrainEngine, kind: RepairKind, apply: boolean, opts: RunOpts = {}) =>
  (await repairRunner(engine, { apply, noEmbed: true, logger: quiet })).run(kind, await resolveRepairScope(engine), { explicit: true, ...opts });

/** The refusal text of an error: its message and detail, where the capability and the step it names are. */
const refusalText = (err: unknown) => JSON.stringify({ message: (err as Error).message, detail: (err as { detail?: unknown }).detail });

/**
 * The preview (apply:false) of one kind. A SQL arm must list something; the Rust engine, when `stop` is given, must stop on a
 * typed refusal whose text carries `stop` (and `refusal` says what the refusal must not be called).
 */
async function previewOrStop(engine: BrainEngine, backend: string, kind: RepairKind, stop: string | null, opts: RunOpts = {}, root?: string) {
  let result: RepairResult;
  try {
    result = await runKind(engine, kind, false, opts);
  } catch (err) {
    if (backend === 'rust' && stop !== null) {
      const text = refusalText(err);
      expect(text).toContain(stop);
      expect(text).not.toContain('access_unreadable');
    }
    throw err;
  }
  expect(result.listing?.length ?? 0).toBeGreaterThan(0);
  return { result, shaped: shape(result, root) };
}

/** A preview, then the apply of what it printed: a SQL arm applies it; the Rust engine refuses the apply by name (`stop`) before its first write. */
async function previewThenApply(engine: BrainEngine, backend: string, kind: RepairKind, stop: string, opts: RunOpts = {}, root?: string) {
  const { result, shaped } = await previewOrStop(engine, backend, kind, null, opts, root);
  try {
    const applied = await runKind(engine, kind, true, { ...opts, expect: result.preview_hash });
    return { preview: shaped, applied: shape(applied, root) };
  } catch (err) {
    if (backend === 'rust') expect(refusalText(err)).toContain(stop);
    throw err;
  }
}

const note = (title: string, frontmatter: Record<string, unknown> = {}, type = 'note') => ({ type: type as 'note', title, compiled_truth: `${title} body.`, timeline: '', frontmatter });

/** Facts through the typed `insertFacts` (no dedup); a row is database-only unless it names a fence row. Returns the ids as numbers. */
async function insert(engine: BrainEngine, rows: Array<Record<string, unknown>>): Promise<number[]> {
  const out = await engine.insertFacts(rows.map(row => ({ kind: 'fact', visibility: 'private', entity_slug: null, row_num: null, source_markdown_slug: null, source: 'test', ...row })) as never, { source_id: 'default' });
  return out.ids.map(Number);
}

/**
 * A result with the seeded fact ids reduced to their seed order (`f0`, `f1`, ...): a Postgres brain draws ids from a sequence
 * the cases before it advanced, so the arms agree on the relation of the ids, never on their value. Ids are named by the keys
 * `id` and `ids` and by `#N`, `fact N` and `fact:N` in a listing's text.
 */
function byOrder(value: unknown, ids: readonly number[]): unknown {
  const name = (n: unknown) => (typeof n === 'number' && ids.includes(n) ? `f${ids.indexOf(n)}` : n);
  const text = (t: string) => t.replace(/(?<=#|fact |fact:)\d+/g, d => String(name(Number(d))));
  const walk = (v: unknown, key = ''): unknown => {
    if (Array.isArray(v)) return v.map(x => walk(x, key));
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    if (typeof v === 'string') return text(v);
    return ['id', 'ids'].includes(key) ? name(v) : v;
  };
  return walk(value);
}

/** A source this host owns and git-canonical: a registered writer, the default source attached to a Git checkout, claimed, `canonical: git`. */
async function strictBrain<T>(engine: BrainEngine, body: (root: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-repair-home-'));
  const root = join(dir, 'brain');
  mkdirSync(join(root, 'notes'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  try {
    return await withEnv({ GBRAIN_HOME: join(dir, 'home'), DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      await engine.attachSourcePath('default', root);
      await registerLocalWriter(engine, 'cli');
      await claimWorktree(engine, 'default', root);
      await engine.updateSourceConfig('default', { canonical: 'git' });
      return await body(root);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('engine parity: repair kind previews of batch 4.3a', () => {
  parityTest('the visibility, open-facts, open-twins and label-write members answer the same rows on every arm', {
    methods: ['putPage', 'insertFacts', 'insertSource', 'listAtomLineageRows', 'listChronicleEventVisibilityRows', 'listAliasOnlyPrivatePages',
      'listOpenTwinRows', 'listCheckoutFiles', 'listPageAccessKeys', 'tightenDatabaseFactVisibility', 'listLinkCandidatePages', 'listOpenFactsWindow',
      'countOpenFactReasons', 'listContextualRetrievalModes', 'listUnembeddedChunkPages'], timeout: 60_000,
  }, async (engine) => {
    const origin = await engine.putPage('notes/origin', note('Origin', { visibility: 'private' }), { sourceId: 'default' });
    await engine.putPage('notes/aliased', note('Aliased', { access: 'private' }), { sourceId: 'default' });
    const atom = await engine.putPage('atoms/one', note('Atom', { source_slug: 'notes/origin' }, 'atom'), { sourceId: 'default' });
    await engine.putPage('events/one', note('Event', { captured_via: 'life-chronicle:example', event: { depth: 'notes/origin' } }, 'event'), { sourceId: 'default' });
    await engine.insertSource({ id: 'other-example', name: 'other-example', local_path: null, config: {} });
    await engine.putPage('notes/origin', note('Twin', { visibility: 'world' }), { sourceId: 'other-example' });
    const ids = await insert(engine, [
      { fact: 'A world fact on the private origin', visibility: 'world', row_num: null, source_markdown_slug: 'notes/origin' },
      { fact: 'A private fact on an open page', visibility: 'private', row_num: null, source_markdown_slug: 'notes/aliased' },
    ]);
    const drop = (rows: object[]) => rows.map(r => { const { id, origin_id, ...rest } = r as Record<string, unknown>; void id; return { ...rest, origin: origin_id === null ? null : typeof origin_id }; });
    const scans = {
      atoms: drop(await engine.listAtomLineageRows(['default'], null, 60_000)),
      oneAtom: drop(await engine.listAtomLineageRows(['default'], [atom.id], 60_000)),
      events: drop(await engine.listChronicleEventVisibilityRows(['default'], null, 60_000)),
      aliases: drop(await engine.listAliasOnlyPrivatePages(['default'], null, 60_000)),
      twins: await engine.listOpenTwinRows([{ source_id: 'default', slug: 'notes/origin' }], [{ identity: [], satisfied: [] }]),
      checkout: await engine.listCheckoutFiles([origin.id, atom.id]),
      access: (await engine.listPageAccessKeys([origin.id, atom.id])).map(r => ({ ...r, id: r.id === origin.id ? 'origin' : 'atom' })),
      typePages: (await engine.listLinkCandidatePages('atom', undefined, 10)).map(r => r.slug),
      modes: await engine.listContextualRetrievalModes([origin.id, atom.id], 60_000),
      unembedded: (await engine.listUnembeddedChunkPages([origin.id, atom.id], 60_000)).map(id => (id === origin.id ? 'origin' : 'atom')),
    };
    const sel = { sourceId: 'default', createdBefore: '2999-01-01T00:00:00Z', ids: null };
    const window = (await engine.listOpenFactsWindow(sel, 0, null, ['fenced', 'unfenced'], 10, 60_000)).map(r => ({ ...r, id: ids.indexOf(Number(r.id)) }));
    const reasons = await engine.countOpenFactReasons(sel, 60_000);
    const tightened = (await engine.tightenDatabaseFactVisibility('default', ids)).map(id => ids.indexOf(id));
    return { scans, window, reasons, tightened };
  });

  /** The facts of a strict source that need no access read: an ontology observation, an entity with a page, with a deleted page, and no entity. */
  async function seedHome(engine: BrainEngine) {
    await engine.putPage('people/alive-example', note('Alive'), { sourceId: 'default' });
    await engine.putPage('people/gone-example', note('Gone'), { sourceId: 'default' });
    await engine.softDeletePage('people/gone-example', { sourceId: 'default' });
    const valid_from = new Date('2026-02-03T10:11:12.345Z');
    return insert(engine, [
      { fact: 'A fact with no entity', entity_slug: null, valid_from },
      { fact: 'A fact of an entity with a page', entity_slug: 'people/alive-example', valid_from },
      { fact: 'A fact of an entity whose page was deleted', entity_slug: 'people/gone-example', valid_from },
      { fact: 'An ontology observation', entity_slug: 'people/alive-example', dimension: 'role', value: 'cto', valid_from },
    ]);
  }

  parityTest('facts-home lists, on a strict source, the facts that need no access read, equal on every arm', {
    methods: ['insertFacts', 'getWorktreeBinding', 'updateSourceConfig', 'attachSourcePath', 'putPage', 'softDeletePage', 'listFactsHomeCandidates', 'listHeldHomeRows', 'listOrphanedFenceRows', 'readFactSnapshots'], timeout: 90_000,
  }, async (engine, backend) => strictBrain(engine, async root => {
    const ids = await seedHome(engine);
    const rows = await engine.listFactsHomeCandidates('default');
    expect(rows.map(row => [Number(row.id), row.page_exists, row.page_deleted, row.dimension])).toEqual([
      [ids[0]!, false, false, null], [ids[1]!, true, false, null], [ids[3]!, true, false, 'role'], [ids[2]!, false, true, null]]);
    expect(await engine.listHeldHomeRows('default', 30)).toEqual([]);
    expect(await engine.listOrphanedFenceRows('default')).toEqual([]);
    expect((await engine.readFactSnapshots('default', [ids[0]!, ids[1]!], false)).map(row => [Number(row.id), row.value.fact, row.value.entity_slug, row.value.visibility, row.value.row_num]))
      .toEqual([[ids[0]!, 'A fact with no entity', null, 'private', null], [ids[1]!, 'A fact of an entity with a page', 'people/alive-example', 'private', null]]);
    expect(await engine.readFactSnapshots('default', [], false)).toEqual([]);
    const { shaped } = await previewOrStop(engine, backend, 'facts-home', null, {}, root);
    expect(shaped.listing.map((row: { class: string }) => row.class).sort()).toEqual(['entity_page_deleted', 'entity_page_exists', 'no_entity', 'ontology_observation']);
    return byOrder({ rows: rows.map(row => ({ ...row, id: Number(row.id), valid_from: row.valid_from!.toISOString() })), preview: shaped }, ids);
  }));

  parityTest('facts-home applies the holding-page write the same way on every arm', {
    methods: ['insertFacts', 'getWorktreeBinding', 'updateSourceConfig', 'attachSourcePath', 'putPage', 'softDeletePage', 'listFactsHomeCandidates', 'listHeldHomeRows', 'listOrphanedFenceRows', 'readFactSnapshots'], timeout: 90_000,
  }, async (engine, backend) => strictBrain(engine, async root => {
    const ids = await seedHome(engine);
    const out = await previewThenApply(engine, backend, 'facts-home', 'repair facts-home page write', {}, root);
    return byOrder(out, ids);
  }));

  /** An entity with no page reaches holdingPageFor, whose folder-access read (readHeldAccessState) the Rust engine does not serve. */
  async function seedEntityWithoutPage(engine: BrainEngine) {
    return insert(engine, [{ fact: 'A fact of an entity with no page', entity_slug: 'people/nobody-example' }]);
  }

  parityTest('facts-home stops on Rust at the folder-access read of a fact whose entity has no page, instead of calling it access_unreadable', {
    methods: ['insertFacts', 'getWorktreeBinding', 'updateSourceConfig', 'attachSourcePath', 'readHeldAccessState'], requires: 'raw_sql', timeout: 90_000,
  }, async (engine, backend) => strictBrain(engine, async root => {
    const ids = await seedEntityWithoutPage(engine);
    const { shaped } = await previewOrStop(engine, backend, 'facts-home', 'readHeldAccessState', {}, root);
    expect(shaped.listing.map((row: { class: string }) => row.class)).toEqual(['entity_page_missing']);
    return byOrder(shaped, ids);
  }));

  parityTest('facts-home with write-through off still stops on Rust at the folder-access read, and does not call the fact access_unreadable', {
    methods: ['insertFacts', 'getWorktreeBinding', 'updateSourceConfig', 'attachSourcePath', 'setConfig', 'readHeldAccessState'], requires: 'raw_sql', timeout: 90_000,
  }, async (engine, backend) => strictBrain(engine, async root => {
    // holdingHome returns null at once with write-through off, so the scan asks holdingPageFor directly: the path whose catch swallowed the refusal.
    await engine.setConfig('sync.write_through', 'false');
    const ids = await seedEntityWithoutPage(engine);
    const { shaped } = await previewOrStop(engine, backend, 'facts-home', 'readHeldAccessState', {}, root);
    expect(shaped.listing.map((row: { class: string }) => row.class)).toEqual(['entity_page_missing']);
    return byOrder(shaped, ids);
  }));

  /** A world fact held on a private page, and one named by the session a private page wrote: the facts class lists both. */
  async function seedWorldFacts(engine: BrainEngine) {
    await engine.putPage('notes/private-example', note('Private', { visibility: 'private' }), { sourceId: 'default' });
    return insert(engine, [
      { fact: 'A world fact held on a private page', visibility: 'world', source_markdown_slug: 'notes/private-example', source: 'mcp:put_page' },
      { fact: 'A world fact a private page wrote', visibility: 'world', source: 'mcp:put_page', source_session: 'put_page:notes/private-example.md' },
    ]);
  }

  parityTest('visibility lists the world facts of a private page, the one class that reads no privacy predicate', {
    methods: ['putPage', 'insertFacts', 'listWorldFactsFromPrivateSources', 'getConfig', 'writeOpCheckpointRecord'], timeout: 60_000,
  }, async (engine, backend) => withHome(async () => {
    const ids = await seedWorldFacts(engine);
    const { shaped } = await previewOrStop(engine, backend, 'visibility', null, { driftClass: 'facts' });
    expect(shaped.listing).toHaveLength(2);
    return byOrder(shaped, ids);
  }));

  parityTest('visibility applies the facts class to a database-only fact the same way on every arm', {
    methods: ['putPage', 'insertFacts', 'listWorldFactsFromPrivateSources', 'getConfig', 'writeOpCheckpointRecord'], timeout: 90_000,
  }, async (engine, backend) => withHome(async () => {
    const ids = await seedWorldFacts(engine);
    const out = await previewThenApply(engine, backend, 'visibility', 'repair visibility page write', { driftClass: 'facts' });
    expect(await engine.listWorldFactsFromPrivateSources(['default'], null)).toEqual([]);
    return byOrder(out, ids);
  }));

  parityTest('visibility previews its default classes (events, aliases, atom lineage) the same way on every arm', {
    methods: ['putPage', 'insertFacts', 'listWorldFactsFromPrivateSources'], timeout: 60_000,
  }, async (engine, backend) => withHome(async () => {
    const ids = await seedWorldFacts(engine);
    const { shaped } = await previewOrStop(engine, backend, 'visibility', 'repair visibility privacy scan');
    expect(shaped.listing.length).toBeGreaterThan(0);
    return byOrder(shaped, ids);
  }));

  parityTest('visibility lists a synthesized concept of the lineage class the same way on every arm', {
    methods: ['putPage', 'listConceptLineageRows', 'listConceptInputRows'], timeout: 60_000,
  }, async (engine, backend) => withHome(async () => {
    await engine.putPage('concepts/lineage-example', note('Lineage', { synthesized_by: 'dream' }, 'concept'), { sourceId: 'default' });
    const { shaped } = await previewOrStop(engine, backend, 'visibility', 'repair visibility privacy scan', { driftClass: 'lineage' });
    const rows = await engine.listConceptLineageRows(['default'], null, 60_000);
    expect(rows.map(row => [row.slug, row.visibility])).toEqual([['concepts/lineage-example', null]]);
    expect(await engine.listConceptInputRows(rows.map(row => Number(row.id)), 60_000)).toEqual([]);
    return shaped;
  }));

  parityTest('visibility lists a named page the same way on every arm', {
    methods: ['putPage', 'listNamedVisibilityRows'], timeout: 60_000,
  }, async (engine, backend) => withHome(async () => {
    await engine.putPage('notes/named-example', note('Named', { visibility: 'world' }), { sourceId: 'default' });
    const { shaped } = await previewOrStop(engine, backend, 'visibility', 'repair visibility privacy scan', { slugs: ['notes/named-example'] });
    const rows = await engine.listNamedVisibilityRows(['default'], ['notes/named-example', 'notes/missing-example'], 60_000);
    expect(rows.map(row => [row.slug, row.visibility, row.guarded])).toEqual([['notes/named-example', 'world', false]]);
    return shaped;
  }));

  parityTest('open-facts lists the private facts a legacy default opened the same way on every arm', {
    methods: ['putPage', 'insertFacts', 'writeOpCheckpointRecord'], timeout: 60_000,
  }, async (engine, backend) => withHome(async home => {
    await engine.putPage('notes/open-holder', note('Holder'), { sourceId: 'default' });
    const ids = await insert(engine, [
      { fact: 'A private fact on an open page', row_num: null, source_markdown_slug: 'notes/open-holder' },
      { fact: 'Another private fact on an open page', row_num: null, source_markdown_slug: 'notes/open-holder' },
    ]);
    const ledger = { path: join(home, 'open-facts-ledger.jsonl'), lines: [], unreadable: 0, record() {} };
    const { shaped } = await previewOrStop(engine, backend, 'open-facts', 'repair open-facts privacy scan',
      { remote: false, openFacts: { createdBefore: '2999-01-01T00:00:00Z', classes: [], ledger } }, home);
    expect(shaped.listing).toHaveLength(2);
    return byOrder(shaped, ids);
  }));
});
