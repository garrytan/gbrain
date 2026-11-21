/**
 * The fact purge's engine surface is one explicit list (src/core/persistence/fact-purge-path-members.ts), and the
 * pre-write check (wired in src/core/ops/purge.ts) is derived only from it. This test runs `purge_fact` through a
 * recording engine proxy and fails when
 *   - the purge calls an engine member that is not on the list (a new purge-path call cannot slip past the check),
 *   - the purge reaches a raw-SQL site that is not on the list,
 *   - a member the purge handler's own source calls is not on the list,
 *   - a listed member is not on all three engines and the Rust member table,
 *   - a member the Rust engine does not serve is not a known stop with an owner and a due date, or a stop is served now,
 *   - the check reads anything but the list, or covers a mode other than the two that write (a real run and
 *     `--status --continue`; a dry run and `--match` only read).
 * It runs on PGLite: the proxy records what the purge calls, which does not depend on the engine.
 *
 * Scenarios: a rich page (fact fence, version, verbatim take, derived fact, take and page, take proposal, open loop,
 * core edit notice), a belief-ledger brain, and the `--status --continue` of a committed purge. A dry run and `--match`
 * are recorded as well, to prove they call no stop.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { RUST_ENGINE_MEMBERS } from '../src/core/rust-engine/members.ts';
import { rustMemberCapability } from '../src/core/rust-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { recordDerivationInputs } from '../src/core/facts/derivation-inputs.ts';
import {
  FACT_PURGE_PATH, factPurgeEntryPoint, factPurgeStops, requireFactPurgeServed, type FactPurgeEntry,
} from '../src/core/persistence/fact-purge-path-members.ts';
import { PURGE_DUE, PURGE_OWNERS, purgeEntryName } from '../src/core/persistence/purge-path-members.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { withEnv } from './helpers/with-env.ts';
import { beliefBrain, beliefPage } from './helpers/belief-ledger.ts';

const RAW_PRIMITIVES = ['executeRaw', 'executeRawDirect', 'withReservedConnection', 'keywordBoundedRead'];
/** What each phase called: a purge's real run, a dry run, `--match`, and the status read with and without `--continue`. */
const phases = { real: new Set<string>(), dry: new Set<string>(), match: new Set<string>(), status: new Set<string>(), resume: new Set<string>() };
const sites = new Set<string>();
/** The raw sites each phase reached. */
const sitesBy: Record<string, Set<string>> = { real: new Set(), dry: new Set(), match: new Set(), status: new Set(), resume: new Set() };
type Phase = keyof typeof phases;
let phase: Phase = 'real';

/** Wraps `engine` (and the transaction handles it hands out) so every member call and every raw-SQL call site is recorded. */
function recording<T extends object>(engine: T): T {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args: unknown[]) => {
        if (RAW_PRIMITIVES.includes(prop)) { const site = rawSite(new Error().stack ?? ''); sites.add(site); sitesBy[phase]!.add(site); }
        else phases[phase].add(prop);
        if ((prop === 'transaction' || prop === 'transactionDirect') && typeof args[0] === 'function') {
          const fn = args[0] as (tx: object) => unknown;
          args = [(tx: object) => fn(recording(tx)), ...args.slice(1)];
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** The first frame in src/ that is not an engine file, as `function (file under src/core)`. */
function rawSite(stack: string): string {
  const frame = stack.split('\n').find(line => line.includes('/src/') && !/\/(pglite|postgres)-engine/.test(line)) ?? '';
  const match = /at (?:async )?(.*?) ?\(?[^\s()]*\/src\/core\/([^:]+):\d+:\d+\)?$/.exec(frame.trim());
  return match ? `${match[1] || '<anonymous>'} (${match[2]})` : frame.trim();
}

const CLAIM = 'Door code is 4417';
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const fence = (rows: string[]) => `<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n${rows.join('\n')}\n<!--- gbrain:facts:end -->`;
const pageBody = (title: string) => `---\ntitle: ${title}\ntype: person\n---\n# ${title}\n\nProse about ${title}.\n\n## Facts\n\n${fence([`| 1 | ${CLAIM} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |`])}\n`;
const ctxOf = (engine: object, extra: Record<string, unknown> = {}) =>
  ({ engine, config: { engine: 'pglite', embedding_disabled: true }, logger: quiet, dryRun: false, remote: false, sourceId: 'default', ...extra }) as unknown as OperationContext;
const purge = operationsByName.purge_fact!;
const run = (engine: object, params: Record<string, unknown>, which: Phase = 'real') => { phase = which; return purge.handler(ctxOf(recording(engine)), params) as Promise<Record<string, any>>; };

let home: string;
let lite: PGLiteEngine;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'fact-purge-path-'));
  await withEnv({ GBRAIN_HOME: home }, async () => {
    lite = new PGLiteEngine();
    await lite.connect({});
    await lite.initSchema();
    await registerLocalWriter(lite, 'cli');
  });
}, 120_000);
afterAll(async () => { await lite?.disconnect().catch(() => undefined); rmSync(home, { recursive: true, force: true }); });

describe('the fact purge calls only what the list names', () => {
  test('a rich page, its derived rows, and the status read of the committed purge', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const slug = 'people/zed-example';
    await importFromContent(lite, slug, pageBody('zed'), { noEmbed: true, sourceId: 'default' });
    await runExtractFacts(lite, { slugs: [slug] });
    const [fact] = await lite.executeRaw<{ id: number }>('SELECT id FROM facts WHERE fact=$1 AND entity_slug=$2', [CLAIM, slug]);
    const [page] = await lite.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug=$1', [slug]);
    await lite.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
      await tx.createVersion(slug, { sourceId: 'default' });
      const [take] = await tx.executeRaw<{ id: number }>(`INSERT INTO takes(page_id,row_num,claim,kind,holder) VALUES ($1,7,$2,'fact','brain') RETURNING id`, [page!.id, CLAIM]);
      const [derivedTake] = await tx.executeRaw<{ id: number }>(`INSERT INTO takes(page_id,row_num,claim,kind,holder) VALUES ($1,90,'A synthesized view of the door','take','brain') RETURNING id`, [page!.id]);
      const inputs = [{ table: 'facts', id: fact!.id }, { table: 'takes', id: take!.id }];
      await recordDerivationInputs(tx, { table: 'takes', id: derivedTake!.id, sourceId: 'default' }, inputs);
      await recordDerivationInputs(tx, { table: 'facts', id: 900_001, sourceId: 'default' }, inputs);
      await recordDerivationInputs(tx, { table: 'pages', id: 900_002, sourceId: 'default' }, inputs);
      await tx.executeRaw(`INSERT INTO take_proposals(source_id,page_slug,content_hash,prompt_version,wave_version,proposal_run_id,claim_text,kind,holder,weight,status,model_id) VALUES ('default',$1,'h','p','w','run-1',$2,'take','brain',0.5,'pending','m')`, [slug, CLAIM]);
      await tx.executeRaw(`INSERT INTO open_loops(source_id,dedup_key,loop_type,summary,page_slug,status,detector,confidence) VALUES ('default','k1','commitment_owed_by_me',$1,$2,'open','manual',0.9)`, [CLAIM, slug]);
      await tx.executeRaw(`INSERT INTO core_edit_notices(source_id,slug,base_text,actor) VALUES ('default',$1,$2,'agent')`, [slug, CLAIM]);
    }, TEST_WRITE_ATTRIBUTION));
    const dry = await run(lite, { id: fact!.id, dry_run: true }, 'dry');
    await run(lite, { match: 'Door' }, 'match');
    const request = randomUUID();
    const done = await run(lite, { id: fact!.id, confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: request });
    expect(done.state).toBe('committed');
    await run(lite, { status: true, request_id: request }, 'status');
    await run(lite, { status: true, continue: true, request_id: request }, 'resume');
  }), 120_000);

  test('a belief-ledger brain', async () => {
    await beliefBrain(async (brain) => {
      await brain.put('notes/ledger', beliefPage({ facts: [CLAIM] }));
      const [fact] = await brain.engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE fact=$1', [CLAIM]);
      phase = 'dry';
      const dry = await purge.handler({ ...brain.ctx, engine: recording(brain.engine) } as OperationContext, { id: fact!.id, dry_run: true }) as Record<string, any>;
      phase = 'real';
      const done = await purge.handler({ ...brain.ctx, engine: recording(brain.engine) } as OperationContext,
        { id: fact!.id, confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() }) as Record<string, any>;
      expect(done.state).toBe('committed');
    }, { managed: false });
  }, 120_000);

  const listed = new Set(FACT_PURGE_PATH.map(purgeEntryName));
  const memberEntries = FACT_PURGE_PATH.filter((entry): entry is Extract<FactPurgeEntry, { member: string }> => 'member' in entry);
  const stopEntries = FACT_PURGE_PATH.filter(entry => ('stop' in entry && entry.stop) || ('refuses' in entry && entry.refuses));

  test('every member the purge called is on the list', () => {
    expect(phases.real.size).toBeGreaterThan(50);
    for (const which of ['real', 'dry', 'match', 'status', 'resume'] as const) {
      expect([...phases[which]].filter(name => !RAW_PRIMITIVES.includes(name) && !listed.has(name)).sort()).toEqual([]);
    }
  });

  test('every raw-SQL site the purge reached is on the list', () => {
    expect(sites.size).toBeGreaterThan(5);
    expect([...sites].filter(site => !listed.has(site)).sort()).toEqual([]);
  });

  test('every member the purge handler calls in its own source is on the list', () => {
    // The recording above reaches what the scenarios reach; the source read adds the branches they do not (a staged upload, a segmented page).
    const source = readFileSync(join(import.meta.dir, '../src/core/facts/purge.ts'), 'utf8');
    const called = new Set([...source.matchAll(/\b(?:tx|engine|ctx\.engine)\.([A-Za-z]+)\(/g)].map(match => match[1]!)
      .filter(name => typeof (PGLiteEngine.prototype as unknown as Record<string, unknown>)[name] === 'function' && !RAW_PRIMITIVES.includes(name)));
    expect(called.size).toBeGreaterThan(30);
    expect([...called].filter(name => !listed.has(name)).sort()).toEqual([]);
  });

  test('every stop on the list was observed (a stop names a call the purge makes) or is named by the purge source', () => {
    const source = readFileSync(join(import.meta.dir, '../src/core/facts/purge.ts'), 'utf8');
    const observed = new Set([...phases.real, ...phases.resume, ...sites]);
    const unobserved = stopEntries.map(purgeEntryName).filter(name => !observed.has(name) && !source.includes(`.${name}(`));
    expect(unobserved).toEqual([]);
  });

  test('a listed member exists on PGLite, Postgres and the Rust member table', () => {
    const missing: string[] = [];
    for (const { member } of memberEntries) {
      if (typeof (PGLiteEngine.prototype as unknown as Record<string, unknown>)[member] !== 'function') missing.push(`${member}: pglite`);
      if (typeof (PostgresEngine.prototype as unknown as Record<string, unknown>)[member] !== 'function') missing.push(`${member}: postgres`);
      if (!(member in RUST_ENGINE_MEMBERS)) missing.push(`${member}: rust`);
    }
    expect(missing).toEqual([]);
  });

  test('a member the Rust engine does not serve is a known stop, and a stop is a member it does not serve', () => {
    expect(memberEntries.filter(entry => rustMemberCapability(entry.member) !== null && !entry.stop).map(entry => entry.member)).toEqual([]);
    expect(memberEntries.filter(entry => entry.stop && rustMemberCapability(entry.member) === null).map(entry => entry.member)).toEqual([]);
    expect(FACT_PURGE_PATH.filter(entry => !entry.owner).map(purgeEntryName)).toEqual([]);
    expect(FACT_PURGE_PATH.filter(entry => 'site' in entry && !entry.stop && !entry.guarded).map(purgeEntryName)).toEqual([]);
    expect(new Set(FACT_PURGE_PATH.map(purgeEntryName)).size).toBe(FACT_PURGE_PATH.length);
  });

  test('every stop names its owner and its due date', () => {
    expect(stopEntries.filter(entry => !entry.owner || !entry.due).map(purgeEntryName)).toEqual([]);
  });

  test('a dry run and --match call nothing the check refuses on', () => {
    // A plain --status is not checked either, but it reads the completion of the purge (listPurgeEffects and the
    // fingerprint count), which are stops; on a Rust brain it gets the engine's own typed refusal, which names them.
    const stops = new Set(stopEntries.map(purgeEntryName));
    expect([...phases.dry, ...phases.match, ...sitesBy.dry!, ...sitesBy.match!].filter(name => stops.has(name))).toEqual([]);
  });

  test('an entry not marked as a real-run entry is reached by --status --continue, and one marked is not', () => {
    const resume = new Set([...phases.resume, ...sitesBy.resume!]);
    const stopsOnly = stopEntries.map(entry => ({ name: purgeEntryName(entry), purgeOnly: entry.entry === 'purge' }));
    expect(stopsOnly.filter(entry => entry.purgeOnly && resume.has(entry.name)).map(entry => entry.name)).toEqual([]);
    expect(stopsOnly.filter(entry => !entry.purgeOnly && !resume.has(entry.name)).map(entry => entry.name)).toEqual([]);
  });

  test('the check reads only the list: PGLite and Postgres have no stop, and the real run lists more than the continue', async () => {
    expect(await factPurgeStops({ kind: 'pglite' })).toEqual([]);
    expect(await factPurgeStops({ kind: 'postgres' })).toEqual([]);
    const real = await factPurgeStops({ kind: 'rust' }, 'purge');
    const resume = await factPurgeStops({ kind: 'rust' }, 'continue');
    for (const stop of [...real, ...resume]) expect(FACT_PURGE_PATH).toContain(stop.entry);
    expect(real.map(stop => stop.name)).toEqual(FACT_PURGE_PATH
      .filter(entry => 'site' in entry ? entry.stop : entry.refuses || rustMemberCapability(entry.member) !== null).map(purgeEntryName));
    expect(resume.map(stop => stop.name)).toEqual(real.filter(stop => stop.entry.entry !== 'purge').map(stop => stop.name));
    expect(resume.length).toBeGreaterThan(0);
    expect(resume.length).toBeLessThan(real.length);
  });

  test('the refusal names the first stop with its owner and due date, in the message and the detail', async () => {
    const [first] = await factPurgeStops({ kind: 'rust' }, 'purge');
    const error = await requireFactPurgeServed({ kind: 'rust' }, 'purge').then(() => null, (e: unknown) => e as { code: string; message: string; detail: string });
    expect(error?.code).toBe('engine_capability_missing');
    expect(error?.message).toContain(`which needs ${first!.name}: `);
    expect(error?.message).toContain(`owner ${first!.owner}, due ${first!.due}`);
    expect(error?.detail).toContain('outcome=none');
    expect(error?.detail).toContain(`owner="${first!.owner}" due="${first!.due}"`);
    expect(await requireFactPurgeServed({ kind: 'pglite' }, 'purge')).toBeUndefined();
  });

  test('which requests the check covers: a real run and --status --continue, never a read or a remote call', () => {
    const base = { remote: false, dryRun: false };
    expect(factPurgeEntryPoint(base, { id: 1, confirm: 'abcd1234' })).toBe('purge');
    expect(factPurgeEntryPoint(base, { id: 1 })).toBe('purge');
    expect(factPurgeEntryPoint(base, { status: true, continue: true, request_id: 'r' })).toBe('continue');
    expect(factPurgeEntryPoint(base, { status: true, request_id: 'r' })).toBeNull();
    expect(factPurgeEntryPoint(base, { id: 1, dry_run: true })).toBeNull();
    expect(factPurgeEntryPoint({ ...base, dryRun: true }, { id: 1 })).toBeNull();
    expect(factPurgeEntryPoint(base, { match: 'Door' })).toBeNull();
    expect(factPurgeEntryPoint({ ...base, remote: true }, { id: 1 })).toBeNull();
  });

  test('owners and due dates come from the page purge list', () => {
    expect(PURGE_OWNERS.factPurgeTx).toBe('lane 4 (rust-5a bc4cc890fe)');
    expect(PURGE_DUE.nov23).toBe('5 PM PST Nov 23');
  });
});
