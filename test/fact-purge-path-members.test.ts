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
 * core edit notice), a segmented page with a retained segmented version plus a staged upload and the write that would
 * publish it (the branches that reach the segmented rewrite and the cancellation of staged writes), a belief-ledger brain,
 * and the `--status --continue` of a committed purge. The order test compares each run's calls with the list order. A dry run and `--match`
 * are recorded as well, to prove they call no stop.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
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
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
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
/** The calls of each recorded run, in the order they were first made (a member or a raw site, by name): the order the list must follow. */
const traces: Array<{ scenario: string; phase: Phase; names: string[] }> = [];
let scenario = '';
/** Starts a recorded run: the next calls are those of `which` in the current scenario. */
function begin(which: Phase): void { phase = which; traces.push({ scenario, phase: which, names: [] }); }
const note = (name: string): void => { const names = traces[traces.length - 1]?.names; if (names && !names.includes(name)) names.push(name); };

/** Wraps `engine` (and the transaction handles it hands out) so every member call and every raw-SQL call site is recorded. */
function recording<T extends object>(engine: T): T {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args: unknown[]) => {
        if (RAW_PRIMITIVES.includes(prop)) { const site = rawSite(new Error().stack ?? ''); sites.add(site); sitesBy[phase]!.add(site); note(site); }
        else { phases[phase].add(prop); note(prop); }
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
const run = (engine: object, params: Record<string, unknown>, which: Phase = 'real') => { begin(which); return purge.handler(ctxOf(recording(engine)), params) as Promise<Record<string, any>>; };

let home: string;
let lite: PGLiteEngine;
let seg: PGLiteEngine;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'fact-purge-path-'));
  await withEnv({ GBRAIN_HOME: home }, async () => {
    lite = new PGLiteEngine();
    await lite.connect({});
    await lite.initSchema();
    await registerLocalWriter(lite, 'cli');
    seg = new PGLiteEngine();
    await seg.connect({});
    await seg.initSchema();
    await seg.setConfig('pages.segmented_storage', 'on');
    await registerLocalWriter(seg, 'cli');
  });
}, 120_000);
afterAll(async () => { await lite?.disconnect().catch(() => undefined); await seg?.disconnect().catch(() => undefined); rmSync(home, { recursive: true, force: true }); });

describe('the fact purge calls only what the list names', () => {
  test('a rich page, its derived rows, and the status read of the committed purge', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    scenario = 'rich page';
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

  test('a segmented page with a retained segmented version, a staged upload and the request that would publish it', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    scenario = 'segmented page and staged upload';
    const slug = 'people/seg-example';
    // Over the inline ceiling, so the page is stored as segments; the second import saves generation 1 as a version.
    const filler = Array.from({ length: 6000 }, (_, i) => `Paragraph ${i} about the garden and the weather ${'x'.repeat(200)}`).join('\n\n');
    const content = `---\ntitle: Seg\ntype: person\n---\n# Seg\n\n${filler}\n\n## Facts\n\n${fence([`| 1 | ${CLAIM} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |`])}\n`;
    await importFromContent(seg, slug, content, { noEmbed: true, sourceId: 'default' });
    await runExtractFacts(seg, { slugs: [slug] });
    await importFromContent(seg, slug, content.replace('Paragraph 5 ', 'Paragraph five '), { noEmbed: true, sourceId: 'default' });
    const [storage] = await seg.executeRaw<{ body_storage: string }>('SELECT body_storage FROM pages WHERE slug=$1', [slug]);
    expect(storage!.body_storage).toBe('segmented');
    const [fact] = await seg.executeRaw<{ id: number }>('SELECT id FROM facts WHERE fact=$1 AND entity_slug=$2', [CLAIM, slug]);
    // Two uploads that hold the claim: one left open (its parts hold it), and one over the inline ceiling that is committed without
    // waiting, so the write that would publish it stays queued while its staged segments hold the claim.
    const uploads = ctxOf(seg);
    const stage = async (body: string, slugOfUpload: string, commit: boolean): Promise<void> => {
      const sha = createHash('sha256').update(body).digest('hex');
      const begin = await operationsByName.begin_page_upload!.handler(uploads, { slug: slugOfUpload, mode: 'create', total_bytes: Buffer.byteLength(body), sha256: sha, request_id: randomUUID() }) as { upload_id: string };
      await operationsByName.upload_page_part!.handler(uploads, { upload_id: begin.upload_id, part: 0, text: body, part_sha256: sha });
      if (commit) await operationsByName.commit_page_upload!.handler(uploads, { upload_id: begin.upload_id, wait_ms: 0 }).catch(() => undefined);
    };
    await stage(`---\ntitle: Open\ntype: note\n---\nThe note says ${CLAIM} twice.\n`, 'notes/open-upload', false);
    await stage(`---\ntitle: Queued\ntype: note\n---\nThe note says ${CLAIM}.\n\n${filler}\n`, 'notes/queued-upload', true);
    // Stop the resident consumer, so the queued write is not claimed (a claimed one refuses the purge).
    await disposePersistenceConsumer(seg);
    const [queued] = await seg.executeRaw<{ state: string }>(`SELECT state FROM persistence_requests WHERE intent->'body_ref'->>'kind'='staging'`);
    expect(queued!.state).toBe('queued');
    const dry = await run(seg, { id: fact!.id, dry_run: true }, 'dry');
    // No expected_revision: the plan's revision moves between the dry run and the transaction while the open upload settles.
    const done = await run(seg, { id: fact!.id, confirm: dry.confirm_token, request_id: randomUUID() });
    expect(done.state).toBe('committed');
    expect(done.purge.removed.persistence_requests_cancelled).toBe(1);
    expect(done.purge.removed.page_body_stagings).toBe(2);
  }), 180_000);

  test('a belief-ledger brain', async () => {
    await beliefBrain(async (brain) => {
      await brain.put('notes/ledger', beliefPage({ facts: [CLAIM] }));
      const [fact] = await brain.engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE fact=$1', [CLAIM]);
      scenario = 'belief ledger';
      begin('dry');
      const dry = await purge.handler({ ...brain.ctx, engine: recording(brain.engine) } as OperationContext, { id: fact!.id, dry_run: true }) as Record<string, any>;
      begin('real');
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
    // test-reads-source-ok[structural]: the inventory's completeness check lists the members and stops the purge handler calls on branches no scenario reaches.
    const source = readFileSync(join(import.meta.dir, '../src/core/facts/purge.ts'), 'utf8');
    const called = new Set([...source.matchAll(/\b(?:tx|engine|ctx\.engine)\.([A-Za-z]+)\(/g)].map(match => match[1]!)
      .filter(name => typeof (PGLiteEngine.prototype as unknown as Record<string, unknown>)[name] === 'function' && !RAW_PRIMITIVES.includes(name)));
    expect(called.size).toBeGreaterThan(30);
    expect([...called].filter(name => !listed.has(name)).sort()).toEqual([]);
  });

  test('every stop on the list was observed (a stop names a call the purge makes) or is named by the purge source', () => {
    // test-reads-source-ok[structural]: the inventory's completeness check lists the members and stops the purge handler calls on branches no scenario reaches.
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

  test('the list is in the order the purge reaches its stops: every recorded run calls them in list order', () => {
    const names = FACT_PURGE_PATH.map(purgeEntryName);
    const stops = new Set(stopEntries.map(purgeEntryName));
    // A derived row's table is hidden and then marked, table by table, so the four hidden-row members share one rank.
    const hiding = ['expireDerivedFacts', 'deactivateDerivedTakes', 'softDeleteDerivedPages', 'markNeedsRederive'];
    const rank = (name: string): number => names.indexOf(hiding.includes(name) ? hiding[0]! : name);
    const runs = traces.filter(trace => trace.phase === 'real' || trace.phase === 'resume');
    expect(runs.map(trace => `${trace.scenario}: ${trace.phase}`).sort()).toEqual(
      ['belief ledger: real', 'rich page: real', 'rich page: resume', 'segmented page and staged upload: real']);
    for (const trace of runs) {
      const called = trace.names.filter(name => stops.has(name));
      // Every member and site of the purge is served on Rust, the belief-ledger steps included (purge-ledger-sites): no run
      // reaches a stop.
      expect(called).toEqual([]);
      // Lists, not sets: the order in which a run first made each call, against the order of the list.
      expect({ run: `${trace.scenario}: ${trace.phase}`, called }).toEqual({ run: `${trace.scenario}: ${trace.phase}`, called: [...called].sort((a, b) => rank(a) - rank(b)) });
    }
  });

  test('no stop is undecided: every owner and due date is named, and the segmented stops carry the ruled label', () => {
    expect(stopEntries.filter(entry => !entry.owner || !entry.due || /undecided/i.test(`${entry.owner} ${entry.due}`)).map(purgeEntryName)).toEqual([]);
    const labelled = (names: string[]) => stopEntries.filter(entry => names.includes(purgeEntryName(entry))).map(entry => ({ name: purgeEntryName(entry), owner: entry.owner, due: entry.due }));
    const all = (names: string[], owner: string, due: string) => expect(labelled(names)).toEqual(names.map(name => ({ name, owner, due })));
    // The two segmented rewrite sites are typed members now (segment-pending-stamp), so they carry no stop and no label.

    expect(PURGE_OWNERS.segmentedRewrite).toBe('trunk (segment-pending-stamp f71c844551, contains 34fa27c472)');
    expect([PURGE_DUE.nov23, PURGE_DUE.nov25]).toEqual(['5 PM PST Nov 23', '5 PM PST Nov 25']);
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
    // Everything a real run and a continue reach is served on Rust (the transaction, the receipt and the belief-ledger
    // steps), so neither has a stop left.
    expect({ real, resume }).toEqual({ real: [], resume: [] });
  });

  test('with no stop left, the check lets a real run and a continue through on every engine', async () => {
    for (const kind of ['rust', 'pglite', 'postgres']) {
      expect(await requireFactPurgeServed({ kind }, 'purge')).toBeUndefined();
      expect(await requireFactPurgeServed({ kind }, 'continue')).toBeUndefined();
    }
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
