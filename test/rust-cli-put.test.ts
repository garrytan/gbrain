/**
 * `gbrain put` and `gbrain get` of pages on a brain with no managed persistence, through the real CLI, on every engine arm.
 *
 * Every CLI write registers the CLI's local writer first (persistence/identity.ts registerLocalWriter), then admits,
 * journals and publishes the page, then runs post-write housekeeping; `get` reads the page snapshot. On the Rust engine
 * each step needs a served store member. Part B serves the local-writer members; part E serves the rest of the path
 * (docs/research/rust-put-get-member-trace.md). Until E is complete the Rust arm stops with engine_capability_missing,
 * so no release built from master can write a page to a Rust brain through `gbrain put`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 * 1. Protects: a CLI page write on a Rust brain gives the answer PGLite (and Postgres, with DATABASE_URL) gives, and
 *    stores the same page.
 * 2. Fails when: the Rust arm's put or the read after it exits non-zero (a typed refusal included), or its JSON answer
 *    or the stored page differ from PGLite's once ids and timestamps are left out.
 * 3. Existing coverage: test/rust-cli-parity.serial.test.ts runs only read commands on the Rust brain, and its import
 *    setup records a refusal as an outcome; the engine-parity put cases call engine.putPage, not the operation's
 *    writer registration.
 * 4. Seams: none. It runs the real CLI. The Rust arm needs the addon `bun run rust:build` writes and skips without it
 *    (GBRAIN_TEST_REQUIRE_RUST_ADDON=1 makes a missing addon an error); the Postgres arm runs with DATABASE_URL.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const TARGET = detectAddonTarget();
const ADDON = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(ADDON);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_REQUIRE_RUST_ADDON === '1') {
  throw new Error(`GBRAIN_TEST_REQUIRE_RUST_ADDON=1 but ${ADDON} does not exist; run bun run rust:build`);
}
const DATABASE_URL = process.env.DATABASE_URL;

type Arm = 'pglite' | 'postgres' | 'rust';
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

/** One brain per arm, each with its own home (so its own local writer credential file) and an empty cwd. */
function brain(arm: Arm): { home: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), `gbrain-rust-cli-put-${arm}-`));
  roots.push(root);
  const home = join(root, 'home');
  const cwd = join(root, 'cwd');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  mkdirSync(cwd);
  const config = arm === 'postgres' ? { engine: 'postgres', database_url: DATABASE_URL } : { engine: arm, database_path: join(root, 'db') };
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(config));
  return { home, cwd };
}

function run(at: { home: string; cwd: string }, args: string[], script: string[] = [CLI]): { status: number; stdout: string; stderr: string } {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) base[key] = value;
  for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_BRAIN_ID', 'GBRAIN_SOURCE']) delete base[key];
  const r = spawnSync(process.execPath, ['--no-env-file', ...script, ...args], {
    cwd: at.cwd,
    encoding: 'utf8',
    env: {
      ...base,
      HOME: at.home,
      GBRAIN_HOME: at.home,
      GBRAIN_SELF_UPGRADE_MODE: 'off',
      GBRAIN_SKIP_STARTUP_HOOKS: '1',
      GBRAIN_SWEEP: '0',
      GBRAIN_RUST_ENGINE_ADDON: ADDON,
    },
    timeout: 120_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})/g;
/**
 * The answer without the values that differ between brains and runs: uuids (request ids, revisions), timestamps, this
 * run's slug token, and the numeric row ids (`id`, `page_id`), since the Postgres arm writes into a shared test
 * database whose sequences earlier runs advanced.
 */
function comparable(stdout: string, token: string): unknown {
  return JSON.parse(stdout.split(token).join('TOKEN').replace(UUID, '<uuid>').replace(TIME, '<time>'),
    (key, value) => (key === 'id' || key === 'page_id') && typeof value === 'number' ? '<id>' : value);
}

/** Every key of `value`, nested ones as `parent.key`, in the order the JSON printed them. */
function keyOrder(value: unknown, at = ''): string[] {
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, inner]) => [`${at}${key}`, ...keyOrder(inner, `${at}${key}.`)]);
}

type Outcome = { puts: unknown[]; gets: unknown[]; order: string[][]; stored: string[] };

/**
 * Puts two pages, then rewrites both (the second, a long page, changes only its last paragraph, so its unchanged chunks
 * are kept), all through the CLI with --json; then reads both back, as JSON and as the stored markdown `gbrain get` prints.
 */
function putThenGet(arm: Arm, token: string): Outcome {
  const at = brain(arm);
  const first = `notes/put-parity-${token}`;
  const second = `notes/put-parity-${token}-two`;
  const page = (title: string, line: string) => `---\ntype: note\ntitle: ${title}\ntags: [probe]\n---\n# ${title}\n\n${line}\n`;
  const step = (args: string[]) => {
    const r = run(at, args);
    if (r.status !== 0) throw new Error(`${arm} ${args.slice(0, 2).join(' ')} exited ${r.status}: ${r.stdout.trim() || r.stderr.trim().slice(-2000)}`);
    return r.stdout;
  };
  const put = (slug: string, content: string, extra: string[] = []) => step(['put', slug, '--content', content, ...extra, '--json']);
  const created = put(first, page('Put parity', 'One page written by gbrain put on a brain with no managed persistence.'));
  const revision = String((JSON.parse(created) as { revision: string }).revision);
  // A body long enough for several chunks: a rewrite that changes only its last paragraph keeps the other chunk rows.
  const long = (last: string) => [...Array.from({ length: 24 }, (_, i) => `## Part ${i + 1}\n\nParagraph ${i + 1} of the long page, `
    + `with enough plain words in it that the page splits into more than one chunk when it is indexed. `.repeat(4)), last].join('\n\n');
  const secondCreated = put(second, page('Second page', long('A second page, so the write path runs on a brain that already holds a page.')));
  const outputs = [
    created,
    secondCreated,
    // The first page again, so an update of a stored page (with the revision the create returned) runs too.
    put(first, page('Put parity', 'The first page again, rewritten.'), ['--expected-revision', revision]),
    // The second page again with only its last paragraph changed, so the rewrite keeps the unchanged chunks.
    put(second, page('Second page', long('The second page again, with only this paragraph changed.')),
      ['--expected-revision', String((JSON.parse(secondCreated) as { revision: string }).revision)]),
  ];
  const puts = outputs.map(stdout => comparable(stdout, token));
  // The first page also by a spelling with a capital: a read finds the page under its lowercase slug, as the put stored it.
  const gets = [first, second, `N${first.slice(1)}`].map(slug => comparable(step(['get', slug, '--json']), token));
  // The CLI prints the same JSON, so the keys come in the same order too (toEqual alone ignores key order).
  const order = [...puts, ...gets].map(answer => keyOrder(answer));
  const stored = [first, second].map(slug => step(['get', slug]).split(token).join('TOKEN'));
  return { puts, gets, order, stored };
}

describe('gbrain put on a brain with no managed persistence', () => {
  const token = randomUUID().slice(0, 8);
  // The PGLite answers are the baseline of every arm, computed once by whichever test asks first, so a run filtered to
  // one engine arm (bun test -t 'Rust:') compares against the real baseline, not an unset variable.
  let baseline: Outcome | undefined;
  const pgliteBaseline = (): Outcome => (baseline ??= putThenGet('pglite', token));

  test('PGLite: the puts commit and the pages read back', () => {
    const pglite = pgliteBaseline();
    for (const put of pglite.puts) expect(put).toMatchObject({ state: 'committed', status: 'created_or_updated', persistence: { mode: 'database' } });
    expect(pglite.gets[0]).toMatchObject({ slug: 'notes/put-parity-TOKEN', title: 'Put parity' });
    expect(pglite.gets[1]).toMatchObject({ slug: 'notes/put-parity-TOKEN-two', title: 'Second page' });
    expect(pglite.gets[2]).toEqual(pglite.gets[0]);
    expect(pglite.stored[0]).toContain('The first page again, rewritten.');
    expect(pglite.stored[1]).toContain('The second page again, with only this paragraph changed.');
  }, 240_000);

  test.skipIf(!DATABASE_URL)('Postgres: the same answers and the same stored pages as PGLite', () => {
    const pglite = pgliteBaseline();
    expect(putThenGet('postgres', token)).toEqual(pglite);
  }, 240_000);

  test.skipIf(!HAVE_ADDON)('Rust: the same answers and the same stored pages as PGLite', () => {
    const pglite = pgliteBaseline();
    expect(putThenGet('rust', token)).toEqual(pglite);
  }, 240_000);
});

/**
 * `gbrain delete` then `gbrain restore` of a page `gbrain put` wrote. restore_page reads through raw SQL the Rust store
 * does not serve, so on Rust the delete must refuse before it lands (a page deleted there could not be restored): the
 * delete exits non-zero with engine_capability_missing and `gbrain get` still reads the page.
 */
function deleteThenRestore(arm: Arm, token: string): { del: { status: number; code: unknown }; restore: number | null; get: number } {
  const at = brain(arm);
  const slug = `notes/delete-parity-${token}`;
  const put = run(at, ['put', slug, '--content', '---\ntype: note\ntitle: Delete parity\n---\nBody.\n', '--json']);
  if (put.status !== 0) throw new Error(`${arm} put exited ${put.status}: ${put.stdout.trim() || put.stderr.trim().slice(-2000)}`);
  const revision = String((JSON.parse(put.stdout) as { revision: string }).revision);
  const del = run(at, ['delete', slug, '--expected-revision', revision, '--json']);
  const code = del.status === 0 ? null : (JSON.parse(del.stdout || del.stderr) as { error?: { code?: unknown }; code?: unknown }).error?.code
    ?? (JSON.parse(del.stdout || del.stderr) as { code?: unknown }).code;
  let restore: number | null = null;
  if (del.status === 0) {
    const deleted = JSON.parse(run(at, ['get', slug, '--include-deleted', '--json']).stdout) as { revision?: string };
    restore = run(at, ['restore', slug, ...(deleted.revision ? ['--expected-revision', deleted.revision] : []), '--json']).status;
  }
  return { del: { status: del.status, code }, restore, get: run(at, ['get', slug, '--json']).status };
}

describe('gbrain delete then gbrain restore on a brain with no managed persistence', () => {
  const token = randomUUID().slice(0, 8);

  test('PGLite: the delete lands and the restore brings the page back', () => {
    expect(deleteThenRestore('pglite', token)).toEqual({ del: { status: 0, code: null }, restore: 0, get: 0 });
  }, 240_000);

  test.skipIf(!HAVE_ADDON)('Rust: the delete refuses before it lands, and the page still reads', () => {
    expect(deleteThenRestore('rust', token)).toEqual({ del: { status: 1, code: 'engine_capability_missing' }, restore: null, get: 0 });
  }, 240_000);
});

type LinkOutcome = { puts: unknown[]; links: unknown; backlinks: unknown };

/**
 * A put of a note whose body wikilinks a page the brain already holds, the common case of a page write. Admission
 * resolves each link target through the source's slug aliases (persistence/links-preparation.ts liveSlugAliases), so
 * on Rust that read must be served: the put commits and the link it stores is the link PGLite stores.
 */
function putWithWikilink(arm: Arm, token: string): LinkOutcome {
  const at = brain(arm);
  const target = `people/link-target-${token}`;
  const note = `notes/link-source-${token}`;
  const step = (args: string[]) => {
    const r = run(at, args);
    if (r.status !== 0) throw new Error(`${arm} ${args.slice(0, 2).join(' ')} exited ${r.status}: ${r.stdout.trim() || r.stderr.trim().slice(-2000)}`);
    return r.stdout;
  };
  const puts = [
    step(['put', target, '--content', `---\ntype: person\ntitle: Link target\n---\n# Link target\n\nA page another page links to.\n`, '--json']),
    step(['put', note, '--content', `---\ntype: note\ntitle: Link source\n---\n# Link source\n\nA note about [[${target}]].\n`, '--json']),
  ].map(stdout => comparable(stdout, token));
  // The stored edge, read straight from the engine: on Rust the `links` and `backlinks` commands still refuse, since
  // they pass a temporal read policy the Rust store does not serve yet (test/rust-cli-parity.serial.test.ts records it).
  const stored = run(at, [note, target], [STORED_LINKS_SCRIPT]);
  if (stored.status !== 0) throw new Error(`${arm} stored-links read exited ${stored.status}: ${stored.stderr.trim().slice(-2000)}`);
  const { links, backlinks } = comparable(stored.stdout, token) as { links: unknown; backlinks: unknown };
  return { puts, links, backlinks };
}

/** Prints `{links, backlinks}` of argv's note and target from the brain the home's config names, by plain engine reads. */
const STORED_LINKS_SCRIPT = join(mkdtempSync(join(tmpdir(), 'gbrain-rust-cli-put-reader-')), 'stored-links.ts');
writeFileSync(STORED_LINKS_SCRIPT, `
const { loadConfig, toEngineConfig } = await import(${JSON.stringify(join(import.meta.dir, '..', 'src', 'core', 'config.ts'))});
const { createEngine } = await import(${JSON.stringify(join(import.meta.dir, '..', 'src', 'core', 'engine-factory.ts'))});
const [note, target] = process.argv.slice(-2);
const config = toEngineConfig(loadConfig());
const engine = await createEngine(config);
await engine.connect(config);
const pick = (rows) => rows.map(({ from_slug, from_source_id, to_slug, to_source_id, link_type, context, link_source }) =>
  ({ from_slug, from_source_id, to_slug, to_source_id, link_type, context, link_source }));
const out = { links: pick(await engine.getLinks(note, { sourceId: 'default' })), backlinks: pick(await engine.getBacklinks(target, { sourceId: 'default' })) };
await engine.disconnect();
process.stdout.write(JSON.stringify(out));
`);
roots.push(dirname(STORED_LINKS_SCRIPT));

describe('gbrain put of a note that wikilinks a stored page, on a brain with no managed persistence', () => {
  const token = randomUUID().slice(0, 8);
  let baseline: LinkOutcome | undefined;
  const pgliteBaseline = (): LinkOutcome => (baseline ??= putWithWikilink('pglite', token));

  test('PGLite: the put commits and stores the link', () => {
    const pglite = pgliteBaseline();
    for (const put of pglite.puts) expect(put).toMatchObject({ state: 'committed', status: 'created_or_updated' });
    expect(JSON.stringify(pglite.links)).toContain('people/link-target-TOKEN');
    expect(JSON.stringify(pglite.backlinks)).toContain('notes/link-source-TOKEN');
  }, 240_000);

  test.skipIf(!DATABASE_URL)('Postgres: the same answers and the same stored link as PGLite', () => {
    expect(putWithWikilink('postgres', token)).toEqual(pgliteBaseline());
  }, 240_000);

  test.skipIf(!HAVE_ADDON)('Rust: the same answers and the same stored link as PGLite', () => {
    expect(putWithWikilink('rust', token)).toEqual(pgliteBaseline());
  }, 240_000);
});
