/**
 * BrainEngine parity: the previews of `gbrain repair fact-claim-dates`, `url-clone-fences`, `captured-facts` and
 * `purged-page-facts`, and the named stops of their applies (batch 4.2 of the repair-on-Rust plan).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a brain seeded so each preview LISTS at least one item, the plan (apply:false) of each of the four
 *    kinds gives the same preview, hash, listing and residuals on PGLite, Postgres (DATABASE_URL) and the Rust engine
 *    (GBRAIN_TEST_RUST_ARM=1). `listFactsOnValidDay`, `readLivePageByPath` and `listPurgedPageFactCandidates` answer
 *    the same rows on every arm. The applies of url-clone-fences, captured-facts and purged-page-facts still write
 *    through raw SQL and the page write door: they run on the SQL arms, and the Rust engine refuses each by name
 *    (`engine_capability_missing`, raw_sql: "repair url-clone-fences page write", "repair captured-facts page write",
 *    "repair purged-page-facts expire") before the first write.
 *  - Regression: the previews of fact-claim-dates (per day), url-clone-fences (per fence-only file) and
 *    purged-page-facts (always) read through `executeRaw`, which a Rust brain refuses, so each stopped at its first
 *    read there. The captured-facts preview was already typed and served; its case here is the first to list a
 *    candidate on every arm.
 *  - Why existing coverage misses it: the repair tests for these kinds seed with raw SQL and run on PGLite or Postgres
 *    only, and the runner parity cases preview empty brains, which prove nothing about a listing.
 *  - Seam: none in a preview. Every fact, page and source is seeded through typed members; the url-clone-fences clone
 *    is a plain git checkout under a temp dir and the captured-facts transcript a file under a temp CLAUDE_CONFIG_DIR.
 *    The populated purged-page-facts case seeds its purge record through the real page purge, which writes
 *    `page_purges` with raw SQL (persistence/page-purge.ts `tombstonePage`), so it stops on a Rust brain at that step
 *    until lane 13 (rust-engine/page-purge-rust) serves the purge. Generated values (hashes, ids, uuids, the temp
 *    root) are compared by shape.
 */
import { describe, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { renderFactsTable, replaceOrInsertFactsFence } from '../../src/core/facts-fence.ts';
import { purgeDeletedPagesCoordinated } from '../../src/core/persistence/purge-deleted.ts';
import { resolveRepairScope, type RepairKind, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';

const { parityTest } = parityArms(testBackends());

const quiet = { info() {}, warn() {}, error() {} } as never;

/** A result with every SHA-256 digest (a preview hash binds the brain id, drawn at random per brain), uuid, page id and backup path (under the temp home) reduced to a marker. */
function shape(result: RepairResult, root?: string) {
  const { scope, ...rest } = result;
  let text = JSON.stringify({ ...rest, scope: { brain_id: typeof scope.brain_id, source_ids: scope.source_ids } })
    .replace(/\b[0-9a-f]{64}\b/g, '<sha256>').replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>')
    .replace(/"page_id":\d+/g, '"page_id":"<id>"').replace(/"backup":"[^"]*"/g, '"backup":"<backup>"');
  if (root) text = text.split(root).join('<root>');
  return JSON.parse(text);
}

async function withHome<T>(fn: (home: string) => Promise<T>, env: Record<string, string | undefined> = {}): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-previews2-home-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, ...env }, () => fn(home));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

type RunOpts = Record<string, unknown>;
const runKind = async (engine: BrainEngine, kind: RepairKind, apply: boolean, opts: RunOpts = {}) =>
  (await repairRunner(engine, { apply, noEmbed: true, logger: quiet })).run(kind, await resolveRepairScope(engine), { explicit: true, ...opts });

/** The preview (apply:false) of one kind; the case fails unless it lists something. */
async function previewOf(engine: BrainEngine, kind: RepairKind, opts: RunOpts = {}) {
  const result = await runKind(engine, kind, false, opts);
  expect(result.listing?.length ?? 0).toBeGreaterThan(0);
  return result;
}

/**
 * A preview, then the apply of what it printed. A SQL arm applies it; the Rust engine must refuse the apply by name
 * (`stop` is in the refusal) before its first write.
 */
async function previewThenApply(engine: BrainEngine, backend: string, kind: RepairKind, stop: string, opts: RunOpts = {}, root?: string) {
  const previewed = await previewOf(engine, kind, opts);
  try {
    const applied = await runKind(engine, kind, true, { ...opts, expect: previewed.preview_hash });
    return { preview: shape(previewed, root), applied: shape(applied, root) };
  } catch (err) {
    if (backend === 'rust') {
      const text = JSON.stringify({ message: (err as Error).message, detail: (err as { detail?: unknown }).detail });
      expect(text).toContain(stop);
    }
    throw err;
  }
}

const note = (title: string, type = 'note') => ({ type: type as 'note', title, compiled_truth: `${title} body.`, timeline: '', frontmatter: {} });

/** Facts through the typed `insertFacts` (no dedup); a row is database-only unless it names a fence row. Returns the ids as numbers. */
async function insert(engine: BrainEngine, rows: Array<Record<string, unknown>>): Promise<number[]> {
  const out = await engine.insertFacts(rows.map(row => ({ kind: 'fact', visibility: 'private', entity_slug: null, row_num: null, source_markdown_slug: null, ...row })) as never, { source_id: 'default' });
  return out.ids.map(Number);
}

/**
 * A result with the seeded fact ids reduced to their seed order (`f0`, `f1`, ...): a Postgres brain draws ids from a sequence
 * the cases before it advanced, so the arms agree on the relation of the ids, never on their value. Ids are named by the keys
 * `id` and `ids` and by `#N` and `fact N` in a listing's text.
 */
function byOrder(value: unknown, ids: readonly number[]): unknown {
  const name = (n: unknown) => (typeof n === 'number' && ids.includes(n) ? `f${ids.indexOf(n)}` : n);
  const text = (t: string) => t.replace(/(?<=#|fact )\d+/g, d => String(name(Number(d))));
  const walk = (v: unknown, key = ''): unknown => {
    if (Array.isArray(v)) return v.map(x => walk(x, key));
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    if (typeof v === 'string') return text(v);
    return ['id', 'ids'].includes(key) ? name(v) : v;
  };
  return walk(value);
}

const num = (n: number | string | null | undefined) => (n === null || n === undefined ? null : Number(n));

describe('engine parity: repair kind previews of batch 4.2', () => {
  parityTest('fact-claim-dates lists the database-only facts of a day whose claim states one earlier date', {
    methods: ['insertFacts', 'listFactsOnValidDay', 'readSourceIncarnation', 'writeOpCheckpointRecord'], timeout: 60_000,
  }, async (engine) => {
    const day = '2026-02-03';
    const on = new Date(`${day}T10:11:12.345678Z`);
    const base = { source: 'test', valid_from: on };
    const ids = await insert(engine, [
      { ...base, fact: 'Acme closed a seed round on 2025-03-14', entity_slug: 'companies/acme-example' },
      { ...base, fact: 'Acme hired a CFO on 2025-06-01', entity_slug: 'companies/acme-example', valid_until: new Date('2027-01-01T00:00:00Z') },
      { ...base, fact: 'Zed raised a round on 2025-02-01', entity_slug: 'people/zed-example' },
      { ...base, fact: 'Acme has no date in its claim', entity_slug: 'companies/acme-example' },
      { ...base, fact: 'Acme met Zed on 2025-01-01 and again on 2025-01-02', entity_slug: 'companies/acme-example' },
      { ...base, fact: 'Acme shut a deal on 2025-04-04 that ended early', valid_until: new Date('2025-01-01T00:00:00Z') },
      { source: 'test', fact: 'Acme opened an office on 2025-05-05', valid_from: new Date('2026-02-04T00:00:00Z') },
    ]);
    const rows = await engine.listFactsOnValidDay('default', day);
    expect(rows.map(row => Number(row.id))).toEqual(ids.slice(0, 6));
    return byOrder({ rows: rows.map(row => ({ ...row, id: Number(row.id), row_num: num(row.row_num) })), preview: shape(await previewOf(engine, 'fact-claim-dates', { day })) }, ids);
  });

  /** A plain git checkout of one page whose working copy carries a fence row gbrain appended, registered as an owned clone with its page. */
  async function ownedClone<T>(engine: BrainEngine, body: (root: string) => Promise<T>): Promise<T> {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-parity-clone-')));
    try {
      const root = join(dir, 'clone');
      mkdirSync(join(root, 'notes'), { recursive: true });
      const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { stdio: 'pipe' });
      const head = '---\ntype: note\ntitle: Acme Example\n---\n\n# Acme Example\n\nA company note.\n';
      writeFileSync(join(root, 'notes/acme-example.md'), head);
      git('init', '-q', '-b', 'main');
      git('add', '-A');
      git('commit', '-q', '-m', 'seed');
      const row = { rowNum: 1, claim: 'Acme Example opened an office in Lisbon.', kind: 'fact' as const, confidence: 1, visibility: 'world' as const, notability: 'medium' as const,
        validFrom: '2026-01-01', source: 'test', active: true };
      writeFileSync(join(root, 'notes/acme-example.md'), replaceOrInsertFactsFence(head, renderFactsTable([row])));
      await engine.insertSource({ id: 'acme-docs', name: 'acme-docs', local_path: root, config: { remote_url: 'https://example.com/acme-docs.git', managed_clone: true } });
      await engine.putPage('notes/acme-example', { ...note('Acme Example'), source_path: 'notes/acme-example.md' }, { sourceId: 'acme-docs' });
      return await withEnv({ GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' }, () => body(root));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  parityTest('url-clone-fences lists a file of an owned clone whose only change is appended fence rows', {
    methods: ['insertSource', 'putPage', 'readSourceState', 'readLivePageByPath', 'writeOpCheckpointRecord'], timeout: 60_000,
  }, async (engine) => withHome(() => ownedClone(engine, async (root) => {
    expect(await engine.readLivePageByPath('acme-docs', 'notes/acme-example.md')).toMatchObject({ slug: 'notes/acme-example' });
    expect(await engine.readLivePageByPath('acme-docs', 'notes/other.md')).toBeNull();
    expect(await engine.readLivePageByPath('default', 'notes/acme-example.md')).toBeNull();
    const result = await runKind(engine, 'url-clone-fences', false, { sourceFlag: 'acme-docs' });
    expect(result.listing?.length ?? 0).toBeGreaterThan(0);
    return { path: await engine.readLivePageByPath('acme-docs', 'notes/acme-example.md').then(page => page?.slug), preview: shape(result, root) };
  })));

  parityTest('url-clone-fences applies the same way on every arm', {
    methods: ['insertSource', 'putPage', 'readSourceState', 'readLivePageByPath', 'writeOpCheckpointRecord'], timeout: 90_000,
  }, async (engine, backend) => withHome(() => ownedClone(engine, async (root) => {
    const out = await previewThenApply(engine, backend, 'url-clone-fences', 'repair url-clone-fences page write', { sourceFlag: 'acme-docs' }, root);
    const status = execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
    expect(status).toBe('');
    return out;
  })));

  /** A claude-cli scratch transcript (the self-capture evidence) and two capture-lane facts of that session, database-only. */
  async function seedCaptured(engine: BrainEngine, claude: string) {
    const scratch = join(claude, 'projects', '-tmp-gbrain-claude-cli-cwd-4242');
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, 'sess-self.jsonl'), '{}\n');
    return insert(engine, [
      { fact: 'Alice Example prefers Rust for systems work', entity_slug: 'people/alice-example', source: 'hook:writeback', source_session: 'sess-self' },
      { fact: 'Acme Example ships quarterly', entity_slug: 'companies/acme-example', source: 'hook:compact', source_session: 'sess-self' },
      { fact: 'Alice Example likes long walks', entity_slug: 'people/alice-example', source: 'hook:writeback', source_session: 'sess-gone' },
    ]);
  }

  parityTest('captured-facts lists the capture-lane facts of a gbrain self-capture session', {
    methods: ['insertFacts', 'listCapturedFactsForClassification', 'getConfig', 'readPersistenceBrainId', 'writeOpCheckpointRecord'], timeout: 60_000,
  }, async (engine) => withHome(async (home) => {
    const claude = join(home, 'claude');
    const ids = await seedCaptured(engine, claude);
    return await withEnv({ CLAUDE_CONFIG_DIR: claude }, async () => {
      const rows = await engine.listCapturedFactsForClassification(['default'], ['hook:writeback', 'hook:compact', 'sweep:corpus'], null);
      expect(rows.map(row => Number(row.id))).toEqual(ids);
      const result = await previewOf(engine, 'captured-facts');
      expect(result.residuals).toMatchObject({ evidenced: 2, unclassifiable: 1 });
      return byOrder({ rows: rows.map(row => ({ ...row, id: Number(row.id), row_num: num(row.row_num) })), preview: shape(result) }, ids);
    });
  }));

  parityTest('captured-facts applies the same way on every arm', {
    methods: ['insertFacts', 'listCapturedFactsForClassification', 'getConfig', 'readPersistenceBrainId', 'writeOpCheckpointRecord'], timeout: 90_000,
  }, async (engine, backend) => withHome(async (home) => {
    const claude = join(home, 'claude');
    const ids = await seedCaptured(engine, claude);
    return await withEnv({ CLAUDE_CONFIG_DIR: claude }, async () => {
      const out = await previewThenApply(engine, backend, 'captured-facts', 'repair captured-facts page write');
      // The two self-capture facts are expired; the fact of the session no transcript names is kept.
      const left = await engine.listCapturedFactsForClassification(['default'], ['hook:writeback', 'hook:compact', 'sweep:corpus'], null);
      expect(left.map(row => Number(row.id))).toEqual([ids[2]!]);
      return byOrder(out, ids);
    });
  }));

  /** Three gone-page facts (one ambiguous, one withdrawn, one another fact names in `superseded_by`) and facts that are not candidates (a live page's, a context with a space). */
  async function seedGone(engine: BrainEngine) {
    await engine.putPage('notes/live-example', note('Live'), { sourceId: 'default' });
    const ids = await insert(engine, [
      { fact: 'An older example claim', source: 'test' },
      { fact: 'Example claim one from the atom', source: 'mcp:put_page', context: 'notes/gone-a — entity inferred from text' },
      { fact: 'Example claim two from the atom', source: 'sync:import', context: 'notes/gone-b' },
      { fact: 'Example claim three from the atom', source: 'mcp:put_page', context: 'notes/gone-c' },
      { fact: 'A live page claim', source: 'mcp:put_page', context: 'notes/live-example' },
      { fact: 'A claim with a spaced head', source: 'mcp:put_page', context: 'not a slug — head has spaces' },
    ]);
    await engine.insertFactWithdrawal('default', 'private', 'Example claim two from the atom', '*', null);
    await engine.expireFact(ids[0]!, { supersededBy: ids[3]! });
    return { ids };
  }

  parityTest('purged-page-facts lists the facts of a gone page with no purge record as ambiguous, and the excluded ones apart', {
    methods: ['putPage', 'insertFacts', 'insertFactWithdrawal', 'expireFact', 'listPurgedPageFactCandidates', 'listSourceIncarnations'], timeout: 60_000,
  }, async (engine) => withHome(async () => {
    const { ids } = await seedGone(engine);
    const rows = await engine.listPurgedPageFactCandidates(['default'], null);
    expect(rows.map(row => [Number(row.id), row.purged, row.withdrawn, row.referenced])).toEqual([[ids[1]!, false, false, false], [ids[2]!, false, true, false], [ids[3]!, false, false, true]]);
    expect((await engine.listPurgedPageFactCandidates(['default'], [ids[2]!])).map(row => Number(row.id))).toEqual([ids[2]!]);
    const result = await previewOf(engine, 'purged-page-facts');
    expect(result.residuals).toMatchObject({ evidenced: 0, ambiguous: 1 });
    return byOrder({ rows: rows.map(row => ({ ...row, id: Number(row.id) })), preview: shape(result) }, ids);
  }));

  /**
   * A page the real purge removes, a fact of it, and a fact of a page that was never recorded. The purge (`purgeDeletedPagesCoordinated`) expires
   * the facts of the page it hard-deletes (`expireGonePageFacts`), and on a brain with no write owner it writes no `page_purges` record
   * (`tombstonePage` runs only in the managed journal's purge), so no typed seed leaves an evidenced candidate: those rows exist only from
   * releases before #8859. The preview lists the unrecorded fact and no evidenced one; the apply retires it.
   */
  async function seedPurged(engine: BrainEngine) {
    await engine.putPage('notes/purged-example', note('Purged'), { sourceId: 'default' });
    const ids = await insert(engine, [{ fact: 'Example claim from a purged page', source: 'mcp:put_page', context: 'notes/purged-example' },
      { fact: 'Example claim from a ghost page', source: 'mcp:put_page', context: 'ghost/example — entity inferred from text' }]);
    await engine.softDeletePage('notes/purged-example', { sourceId: 'default' });
    await purgeDeletedPagesCoordinated(engine, 0);
    return ids;
  }

  // The purge reads and writes through raw SQL until lane 13 (rust-engine/page-purge-rust) serves it: the Rust arm stops on the
  // typed refusal at the purge step, before the preview. When lane 13 lands this case turns equal.
  parityTest('purged-page-facts after a real page purge lists only the unrecorded gone page, and applies; the Rust engine stops at the page purge step', {
    methods: ['putPage', 'insertFacts', 'softDeletePage', 'listPurgedPageFactCandidates', 'listSourceIncarnations', 'writeOpCheckpointRecord'], requires: 'raw_sql', timeout: 120_000,
  }, async (engine, backend) => withHome(async () => {
    let ids: number[];
    try {
      ids = await seedPurged(engine);
    } catch (err) {
      if (backend === 'rust') expect(JSON.stringify({ message: (err as Error).message, detail: (err as { detail?: unknown }).detail })).toContain('raw_sql');
      throw err;
    }
    const rows = await engine.listPurgedPageFactCandidates(['default'], null);
    expect(rows.map(row => [Number(row.id), row.purged])).toEqual([[ids[1]!, false]]);
    const out = await previewThenApply(engine, backend, 'purged-page-facts', 'repair purged-page-facts expire', { includeAmbiguous: true });
    expect(await engine.listPurgedPageFactCandidates(['default'], null)).toEqual([]);
    return byOrder({ rows: rows.map(row => ({ ...row, id: Number(row.id) })), ...out }, ids);
  }));

  parityTest('purged-page-facts applies a preview that lists an ambiguous fact the same way on every arm', {
    methods: ['putPage', 'insertFacts', 'insertFactWithdrawal', 'expireFact', 'listPurgedPageFactCandidates', 'listSourceIncarnations', 'writeOpCheckpointRecord'], timeout: 90_000,
  }, async (engine, backend) => withHome(async () => {
    const { ids } = await seedGone(engine);
    const out = await previewThenApply(engine, backend, 'purged-page-facts', 'repair purged-page-facts expire', { includeAmbiguous: true });
    return byOrder(out, ids);
  }));
});
