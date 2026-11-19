/**
 * A Rust brain returns every jsonb value in jsonb key order, as Postgres and PGLite do: shorter keys first, then
 * by bytes, at every depth. The contract is byte-exact CLI and MCP JSON, so each case reads the keys in the order
 * the output text gives them (JSON.parse keeps it) and compares that text with the PGLite brain's.
 *
 * The page is written with frontmatter keys {zz, a, mm, b: {y, x}}; the fact and timeline entry with a write origin
 * in that order. CLI `get --json` and MCP get_page read through readPageSnapshot with resolveAlias, which the Rust
 * engine refuses today, so those two cases pass on a typed refusal and compare bytes once the read answers; the
 * engine reads under them (getPage, readPageSnapshot, listPages, getVersions) are compared exactly.
 * A take's write origin is stored in `RowTrust` (rust/crates/gbrain-store/src/trust/row_trust.rs) and reads in jsonb order too.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { loadRustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { openRustEngine } from '../src/core/rust-engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const TARGET = detectAddonTarget();
const ADDON = TARGET ? join(ROOT, 'rust', 'target', 'addon', `gbrain_engine.${TARGET}.node`) : '';
const HAVE_ADDON = !!TARGET && existsSync(ADDON);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${ADDON || 'no addon target'} does not exist; run bun run rust:build`);
}

type Backend = 'pglite' | 'rust';
interface Brain { backend: Backend; home: string; db: string }
interface Run { exitCode: number; stdout: string; stderr: string }

let root = '';
const SLUG = 'notes/order-probe';
const PAGE = '---\ntype: note\ntitle: Order probe\nzz: 1\na: 2\nmm: 3\nb:\n  y: 1\n  x: 2\n---\n\n# Order probe\n\nKey order probe.\n';
/** jsonb order of the page's frontmatter (type and title live in their own columns): shorter keys first, then by bytes, at every depth. */
const PAGE_ORDER = '{"a":2,"b":{"x":2,"y":1},"mm":3,"zz":1}';
const FRONTMATTER = '{"zz":1,"a":2,"mm":3,"b":{"y":1,"x":2}}';
const ORIGIN = '{"zz":1,"a":2,"mm":3,"b":{"y":1,"x":2}}';
const ORIGIN_ORDER = '{"a":2,"b":{"x":2,"y":1},"mm":3,"zz":1}';

function childEnv(brain: Brain): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  for (const key of Object.keys(out)) {
    if (/^(DATABASE_URL|GBRAIN_DATABASE_URL|GBRAIN_BRAIN_ID|GBRAIN_SOURCE|GBRAIN_RUST_ENGINE_ADDON)$/.test(key)) delete out[key];
    if (/(_API_KEY|_API_TOKEN)(__|$)/.test(key)) delete out[key]; // keyless: no provider is ever called
  }
  return {
    ...out, HOME: brain.home, GBRAIN_HOME: brain.home, GBRAIN_SELF_UPGRADE_MODE: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1',
    GBRAIN_SWEEP: '0', TZ: 'UTC', ...(brain.backend === 'rust' ? { GBRAIN_RUST_ENGINE_ADDON: ADDON } : {}),
  };
}

async function cli(brain: Brain, args: string[]): Promise<Run> {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], { cwd: root, env: childEnv(brain), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

function expectOk(run: Run, what: string): Run {
  if (run.exitCode !== 0) throw new Error(`${what} exited ${run.exitCode}\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
  return run;
}

async function withEngine<T>(brain: Brain, fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
  const engine: BrainEngine = brain.backend === 'rust'
    ? openRustEngine({ addon: await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: ADDON } }), databasePath: brain.db })
    : new PGLiteEngine();
  await engine.connect({ engine: brain.backend, database_path: brain.db } as never);
  try { return await fn(engine); } finally { await engine.disconnect(); }
}

/** The key order of `value` as text: JSON.parse keeps the order of the output it read. */
const order = (value: unknown): string => JSON.stringify(value);

/** The MCP answer's JSON text, parsed, or `{ refused: code }` for an error answer. */
function mcpJson(result: { content: { type: string; text?: string }[]; isError?: boolean }): any {
  const text = result.content[0]?.text ?? '';
  if (result.isError) return { refused: (() => { try { return JSON.parse(text).code ?? text; } catch { return text.slice(0, 300); } })() };
  return JSON.parse(text);
}

interface Reads {
  /** CLI `get --json` and MCP get_page: the frontmatter text, or `{"refused": code}` when the engine refuses the read. */
  get: string; mcpGet: string;
  /** The engine reads those surfaces sit on: getPage, readPageSnapshot, listPages (all columns), getVersions. */
  getPage: string; snapshot: string; listPages: string; version: string;
  /** What createVersion and putPage answer with, read from the write itself. */
  created: string; put: string;
  exported: string; fact: string; timeline: string; take: string;
}

/** The text of a read that may refuse: the value's JSON, or `{"refused": code}`. */
async function orRefusal(read: () => Promise<unknown>): Promise<string> {
  try { return order(await read()); } catch (error) {
    const code = (error as { code?: string }).code;
    if (!code) throw error;
    return order({ refused: code });
  }
}

/** Builds one brain and reads every surface the cases compare. */
async function readBrain(backend: Backend): Promise<Reads> {
  const home = join(root, backend, 'home');
  const db = join(root, backend, 'db');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: backend, database_path: db }));
  const brain: Brain = { backend, home, db };
  expectOk(await cli(brain, ['import', join(root, 'corpus'), '--no-embed']), `${backend} import`);

  const run = await cli(brain, ['get', SLUG, '--json']);
  const getJson = JSON.parse(run.stdout || 'null');
  const get = order(run.exitCode === 0 ? getJson.frontmatter : { refused: getJson?.code ?? `exit ${run.exitCode}` });
  const out = join(root, backend, 'export');
  expectOk(await cli(brain, ['export', '--dir', out]), `${backend} export`);
  const exported = readFileSync(join(out, `${SLUG}.md`), 'utf8');

  return withEngine(brain, async (engine) => {
    const mcp = mcpJson(await dispatchToolCall(engine, 'get_page', { slug: SLUG }, { remote: false }) as never);
    const mcpGet = order(mcp.refused ? { refused: mcp.refused } : mcp.frontmatter);
    // A version of the page, then a second write, so getVersions has a row holding the frontmatter.
    const created = order((await engine.createVersion(SLUG)).frontmatter);
    const put = order((await engine.putPage(SLUG, { type: 'note', title: 'Order probe', compiled_truth: 'Key order probe, edited.', frontmatter: JSON.parse(FRONTMATTER) })).frontmatter);
    const getPage = order((await engine.getPage(SLUG))!.frontmatter);
    const snapshot = order((await engine.readPageSnapshot(SLUG))!.page.frontmatter);
    const listPages = order((await engine.listPages({ limit: 10 })).find(p => p.slug === SLUG)!.frontmatter);
    const version = await orRefusal(async () => (await engine.getVersions(SLUG))[0]!.frontmatter);
    let factId = 0;
    let timelineId = 0;
    let takeId = 0;
    await engine.transaction(async (tx) => {
      await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_origin'], ['agent_written', ORIGIN]);
      factId = (await tx.insertFact({ fact: 'Order probe fact', entity_slug: SLUG, source: 'test:order', visibility: 'world' }, { source_id: 'default' })).id;
      await tx.addTimelineEntry(SLUG, { date: '2026-01-02', summary: 'Order probe event', source: 'test:order' });
      const page = (await tx.getPage(SLUG))!;
      await tx.addTakesBatch([{ page_id: Number(page.id), row_num: 1, claim: 'Order probe take', kind: 'bet', holder: 'self' }]);
    });
    const fact = (await engine.listFactsByEntity('default', SLUG)).find(f => Number(f.id) === Number(factId))!;
    timelineId = Number((await engine.getTimeline(SLUG)).find(t => t.summary === 'Order probe event')!.id);
    takeId = Number((await engine.listTakes({}))[0]!.id);
    const timeline = await orRefusal(async () => (await engine.readRowTrustRows({ table: 'timeline_entries', ids: [timelineId] }))[0]?.write_origin);
    const take = await orRefusal(async () => (await engine.readRowTrustRows({ table: 'takes', ids: [takeId] }))[0]?.write_origin);
    return { get, mcpGet, getPage, snapshot, listPages, version, created, put, exported, fact: order(fact.write_origin), timeline, take };
  });
}

/** A surface the Rust engine refuses today answers with the PGLite bytes once it answers at all. */
function expectRefusedOrExact(rust: string, pglite: string): void {
  if (rust === order({ refused: 'engine_capability_missing' })) return;
  expect(rust).toBe(pglite);
}

describe.skipIf(!HAVE_ADDON)('a Rust brain returns jsonb keys in jsonb order', () => {
  let rust: Reads;
  let pglite: Reads;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'gbrain-jsonb-order-'));
    mkdirSync(join(root, 'corpus', 'notes'), { recursive: true });
    writeFileSync(join(root, 'corpus', `${SLUG}.md`), PAGE);
    pglite = await readBrain('pglite');
    rust = await readBrain('rust');
  }, 240_000);
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  test('PGLite gives every jsonb value in jsonb order (the reference)', () => {
    for (const fm of [pglite.get, pglite.mcpGet, pglite.getPage, pglite.snapshot, pglite.listPages, pglite.version, pglite.created, pglite.put]) expect(fm).toBe(PAGE_ORDER);
    for (const origin of [pglite.fact, pglite.timeline, pglite.take]) expect(origin).toBe(ORIGIN_ORDER);
  });
  test('getPage gives the frontmatter keys in jsonb order', () => { expect(rust.getPage).toBe(pglite.getPage); });
  test('readPageSnapshot gives the frontmatter keys in jsonb order', () => { expect(rust.snapshot).toBe(pglite.snapshot); });
  test('listPages gives the frontmatter keys in jsonb order', () => { expect(rust.listPages).toBe(pglite.listPages); });
  test('a page version gives the frontmatter keys in jsonb order', () => { expect(rust.version).toBe(pglite.version); });
  test('createVersion answers with the frontmatter keys in jsonb order', () => { expect(rust.created).toBe(pglite.created); });
  test('putPage answers with the frontmatter keys in jsonb order', () => { expect(rust.put).toBe(pglite.put); });
  // CLI get and MCP get_page read through readPageSnapshot with resolveAlias, which the Rust engine refuses today.
  test('CLI get --json refuses on Rust, or gives the frontmatter keys in jsonb order', () => { expectRefusedOrExact(rust.get, pglite.get); });
  test('MCP get_page refuses on Rust, or gives the frontmatter keys in jsonb order', () => { expectRefusedOrExact(rust.mcpGet, pglite.mcpGet); });
  test('export writes the frontmatter keys in jsonb order', () => { expect(rust.exported).toBe(pglite.exported); });
  test("a fact's write origin reads in jsonb order", () => { expect(rust.fact).toBe(pglite.fact); });
  test("a timeline entry's write origin reads in jsonb order", () => { expect(rust.timeline).toBe(pglite.timeline); });
  test("a take's write origin reads in jsonb order", () => { expect(rust.take).toBe(pglite.take); });
});
