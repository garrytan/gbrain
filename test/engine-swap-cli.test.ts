/**
 * `gbrain engine swap` (PR S5a): the read-only plan's CLI contract and the `engine_swap_refused` recovery table.
 *
 * Authoring gate (docs/TESTING.md): (1) protects what an agent reads before a swap: one JSON plan document, a stable plan
 * hash, engine-selecting variables and service definitions by name only, and a complete recovery row for every
 * refusal reason. (2) Fails when the plan prints a variable's value, when the hash moves with a volatile reading, when
 * a flag of the later run is accepted, or when a reason has no registry entry, recovery row or guide anchor. (3) The
 * refresh gate has its own test (engine-swap-refresh-drain.test.ts). (4) No seam beyond injected env, home and status.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { renderCliError } from '../src/core/agent-output.ts';
import { runEngineSwap, serviceDefinitions, type EngineSwapCliDeps } from '../src/commands/engine-swap.ts';
import { existsSync } from 'node:fs';
import { withEnv } from './helpers/with-env.ts';
import { CODES } from '../src/core/error-registry.ts';
import { SWAP_RECOVERY, SWAP_REFUSAL_REASONS } from '../src/core/engine-swap/refusals.ts';
import { WRITE_BOOKKEEPING_TABLES, WRITE_COVERAGE_LIMIT, WRITE_COVERAGE_LOSS, WRITE_COVERAGE_NAMED, WRITE_NOT_VERIFIED, WRITE_SIDE_TABLES, WRITE_TABLE_LOSS, type ShadowStatus } from '../src/core/engine-swap/readiness.ts';
import { PILOT_WRITES, writeFamily } from '../src/shadow/write-compare.ts';
import { sampledStatements } from '../src/shadow/write-capture.ts';
import { WRITE_MAP } from '../src/shadow/write-map.ts';

let engine: PGLiteEngine;
let home: string;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  home = mkdtempSync(join(tmpdir(), 'gbrain-swap-home-'));
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(join(home, 'Library', 'LaunchAgents', 'com.gbrain.serve.plist'), '<key>GBRAIN_DATABASE_URL</key><string>postgresql://h/db?app=VALUECANARY</string>');
  writeFileSync(join(home, 'Library', 'LaunchAgents', 'com.other.app.plist'), 'DATABASE_URL');
}, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

async function run(args: string[], extra: Partial<EngineSwapCliDeps> = {}) {
  let stdout = '';
  let error = '';
  const code = await runEngineSwap(args, {
    openEngine: async () => Object.assign(Object.create(engine), { disconnect: async () => undefined }) as BrainEngine,
    env: { GBRAIN_DATABASE_URL: 'postgresql://db.example/brain?app=VALUECANARY', HOME: home },
    home, dataDir: home, resolveBrain: () => 'host', cliBrain: null,
    out: t => { stdout += t; },
    writeError: (e, o) => { const r = renderCliError(e, { json: o.json, command: 'engine swap', tty: false }); error = r.stdout ?? r.stderr ?? ''; return r.exitCode; },
    ...extra,
  });
  return { code, stdout, error };
}

describe('engine swap --plan', () => {
  test('a service definition that cannot be read is marked unread, not listed as setting nothing', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'gbrain-swap-svc-'));
    try {
      const dir = join(fakeHome, '.config', 'systemd', 'user');
      mkdirSync(dir, { recursive: true });
      // A directory where a unit file is expected: readFileSync throws EISDIR, the same as an unreadable file.
      mkdirSync(join(dir, 'gbrain-serve.service'));
      writeFileSync(join(dir, 'gbrain-sync.service'), 'Environment=GBRAIN_DATABASE_URL=postgresql://x/y\n');
      expect(serviceDefinitions(fakeHome)).toEqual([
        { name: 'gbrain-serve.service', kind: 'systemd', sets: [], unread: 'read_failed' },
        { name: 'gbrain-sync.service', kind: 'systemd', sets: ['GBRAIN_DATABASE_URL'] },
      ]);
      const human = await run(['--to', 'rust', '--dry-run'], { home: fakeHome, env: { HOME: fakeHome } });
      expect(human.stdout).toContain('gbrain-serve.service (systemd; unreadable, names unknown)');
      expect(human.stdout).toContain('gbrain-sync.service (systemd; sets GBRAIN_DATABASE_URL)');
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test('prints one JSON plan with names only, never values', async () => {
    const r = await run(['--to', 'rust', '--plan', '--json']);
    expect(r.code).toBe(0);
    const plan = JSON.parse(r.stdout);
    expect(plan.schema_version).toBe(1);
    expect(plan.to).toBe('rust');
    expect(plan.from).toBe('pglite');
    expect(plan.verdict).toBe('NOT READY');
    expect(plan.shadow).toBe(false);
    expect(plan.criteria).toHaveLength(11);
    expect(plan.routes.env).toEqual(['GBRAIN_DATABASE_URL']);
    expect(plan.routes.services).toEqual([{ name: 'com.gbrain.serve.plist', kind: 'launchd', sets: ['GBRAIN_DATABASE_URL'] }]);
    expect(typeof plan.disk.free_bytes).toBe('number');
    expect(Object.keys(plan.deferred).sort()).toEqual(['capability_report', 'expected_write_pause']);
    expect(plan.plan_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(r.stdout).not.toContain('VALUECANARY');
  });

  test('the human plan names the verdict, every criterion and the deferred items, and no value', async () => {
    const r = await run(['--to', 'rust', '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('verdict: NOT READY (no_shadow)');
    expect(r.stdout).toContain('8. [reported] speed (reported, not gating: D23)');
    expect(r.stdout).toContain('Capability report: ');
    expect(r.stdout).toContain('Expected write pause: ');
    expect(r.stdout).toContain('Nothing was written.');
    expect(r.stdout).not.toContain('VALUECANARY');
  });

  test('the plan hash ignores volatile readings and moves with the routes', async () => {
    const a = JSON.parse((await run(['--to', 'rust', '--plan', '--json'], { now: new Date('2026-11-21T00:00:00Z') })).stdout);
    const b = JSON.parse((await run(['--to', 'rust', '--plan', '--json'], { now: new Date('2026-11-22T00:00:00Z'), dataDir: tmpdir() })).stdout);
    expect(b.plan_hash).toBe(a.plan_hash);
    const c = JSON.parse((await run(['--to', 'rust', '--plan', '--json'], { env: { HOME: home, DATABASE_URL: 'x' } })).stdout);
    expect(c.plan_hash).not.toBe(a.plan_hash);
  });

  test.each([
    [['--to', 'rust'], 'add --plan'],
    [['--to', 'rust', '--yes', '--expect', 'abc'], 'not supported yet: --yes --expect'],
    [['--to', 'postgres', '--plan'], '--to postgres is not available'],
    [['--plan'], '--to (missing) is not available'],
  ])('%j is refused as usage, before the brain is opened', async (args, text) => {
    let opened = false;
    const r = await run(args as string[], { openEngine: async () => { opened = true; throw new Error('opened'); } });
    expect(r.code).toBe(2);
    expect(opened).toBe(false);
    expect(r.error).toContain(text);
  });
});

describe('engine swap --plan opens only the host brain, and only if it exists', () => {
  test('a mounted brain is refused before anything is opened', async () => {
    let opened = false;
    const r = await run(['--to', 'rust', '--plan', '--json'], { resolveBrain: () => 'team-x', openEngine: async () => { opened = true; throw new Error('opened'); } });
    expect(opened).toBe(false);
    expect(r.code).toBe(3);
    const env = JSON.parse(r.error);
    expect(env.code).toBe('engine_swap_refused');
    expect(env.reason).toBe('team_brain');
    expect(env.message).toContain('team-x is a mounted brain');
  });

  test('--brain reaches the brain resolver', async () => {
    const asked: Array<string | null> = [];
    await run(['--to', 'rust', '--plan', '--brain', 'mount-a', '--json'], { resolveBrain: e => { asked.push(e); return 'mount-a'; } });
    expect(asked).toEqual(['mount-a']);
  });

  test('the global --brain flag (stripped before dispatch) reaches the resolver', async () => {
    const asked: Array<string | null> = [];
    const r = await run(['--to', 'rust', '--plan', '--json'], { cliBrain: 'team-x', resolveBrain: e => { asked.push(e); return e ?? 'host'; } });
    expect(asked).toEqual(['team-x']);
    expect(JSON.parse(r.error).reason).toBe('team_brain');
  });

  test('an existing empty directory is not a brain: refused, and nothing is created in it', async () => {
    const gh = mkdtempSync(join(tmpdir(), 'gbrain-swap-cfg-'));
    const empty = join(gh, 'empty-brain');
    mkdirSync(empty);
    mkdirSync(join(gh, '.gbrain'), { recursive: true });
    writeFileSync(join(gh, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: empty }));
    try {
      let error = '';
      const code = await withEnv({ GBRAIN_HOME: gh, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_BRAIN_ID: undefined }, () => runEngineSwap(['--to', 'rust', '--plan', '--json'], {
        resolveBrain: () => 'host', env: {}, home: '', out: () => undefined,
        writeError: (e, o) => { const r = renderCliError(e, { json: o.json, command: 'engine swap', tty: false }); error = r.stdout ?? ''; return r.exitCode; },
      }));
      expect(code).not.toBe(0);
      expect(JSON.parse(error).code).toBe('no_brain');
      expect(readdirSync(empty)).toEqual([]);
    } finally { rmSync(gh, { recursive: true, force: true }); }
  }, 60_000);

  test('a configured PGLite path that does not exist is refused and never created', async () => {
    const gh = mkdtempSync(join(tmpdir(), 'gbrain-swap-cfg-'));
    const missing = join(gh, 'no-such-brain');
    mkdirSync(join(gh, '.gbrain'), { recursive: true });
    writeFileSync(join(gh, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: missing }));
    try {
      let error = '';
      const code = await withEnv({ GBRAIN_HOME: gh, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_BRAIN_ID: undefined }, () => runEngineSwap(['--to', 'rust', '--plan', '--json'], {
        resolveBrain: () => 'host', env: {}, home: '', out: () => undefined,
        writeError: (e, o) => { const r = renderCliError(e, { json: o.json, command: 'engine swap', tty: false }); error = r.stdout ?? ''; return r.exitCode; },
      }));
      expect(code).not.toBe(0);
      expect(JSON.parse(error).code).toBe('no_brain');
      expect(existsSync(missing)).toBe(false);
    } finally { rmSync(gh, { recursive: true, force: true }); }
  });
});

describe('engine_swap_refused recovery table', () => {
  const guide = readFileSync(join(import.meta.dir, '..', 'docs', 'guides', 'engine-swap.md'), 'utf8');
  test('the registry entry lists exactly the recovery table reasons', () => {
    const entry = CODES.engine_swap_refused as import('../src/core/error-registry.ts').CodeEntry;
    expect([...entry.reasons!]).toEqual([...SWAP_REFUSAL_REASONS]);
    for (const reason of SWAP_REFUSAL_REASONS) {
      const row = SWAP_RECOVERY[reason];
      const override = entry.reason_overrides?.[reason];
      expect(override?.class ?? entry.class).toBe(row.class);
      expect(override?.exit ?? 1).toBe(row.exit);
    }
  });
  test.each([...SWAP_REFUSAL_REASONS])('%s has a complete row and a guide anchor', reason => {
    const row = SWAP_RECOVERY[reason];
    for (const k of ['blocker', 'authority', 'side_effects', 'retry'] as const) expect(row[k].length).toBeGreaterThan(10);
    expect(row.anchor).toBe(`docs/guides/engine-swap.md#${reason}`);
    expect(guide).toContain(`<a id="${reason}"></a>`);
  });
});

describe('the swap report names each write type criterion 5 does not compare', () => {
  const NAMED_LOSS = 'Named loss: only putPage, deletePage, addLink, addLinksBatch and removeLink are compared, so these other page and link writes are counted capability_missing and are not compared: pages:deletePages, pages:softDeletePage, pages:softDeletePages, pages:restorePage, pages:purgeDeletedPages, pages:updateSlug, pages:refreshPageBody, pages:refreshPageOrigin, pages:updatePageContextualRetrievalState, pages:stripStaleFrontmatterKeys, pages:markPagesExtractedBatch, pages:markPagesAttendanceBlocked, pages:setPageEmbeddingSignature, pages:setChunkerVersion, pages:writeTextProjectionSeal, pages:sealImportedPage, pages:revertToVersion, pages:setEmotionalWeightBatch, pages:invalidateWithdrawnPages, pages:createSegmentedPageShell, pages:sealSegmentedPage, pages:flipBodyGeneration, links:removeLinksByPagesAndSource, links:replaceDerivedLinks, links:replaceDerivedLinksBatch. A write that touches several tables is counted under its first table only, so the side effects of deletePages, purgeDeletedPages and updateSlug (aliases, open loops, owner-only marks, fact withdrawals) land under pages:* keys, and a type\'s line above reads only the writes whose first table it is.';
  const NOT_VERIFIED = 'named, not verified: each count on these lines is a sampled write that was not compared; none counts toward the comparable count or the write bar';
  const TABLE_LOSS = 'Named loss: raw SQL statements and typed members outside the write map are counted under the first table they write, named, not verified: timeline_entries, takes and sources (their lines above); the side tables wanted_links, link_transitions, page_retrievals, mention_index_status, page_mention_state and memory_proposals; the process bookkeeping tables persistence_effects, persistence_requests, persistence_counters, persistence_consumers, op_checkpoints, op_checkpoint_paths, sync_notifier_leases, sync_notifier_sources, sync_wanted_markers, session_context_state and write_gate_receipts; and a member or raw statement that only sets transaction settings or takes locks, under no_row: and its name (no_row:declarePersistence, or no_row:executeRaw for raw SQL). A raw statement the parser cannot read stays raw_sql, and a typed member with no known statements is counted under unmapped: and its name.';
  const sampled = (byFamily: Record<string, unknown>) => ({
    write_comparisons: { state: 'measured', sample_rate: 1, comparable: 5, unexplained_difference: 0, uncomparable: 0, capability_missing: 0, capability_missing_by_family: byFamily },
  }) as unknown as ShadowStatus;
  const plan = async (doc: ShadowStatus, json: boolean) => {
    const r = await run(['--to', 'rust', '--plan', ...(json ? ['--json'] : [])], { readShadowStatus: async () => doc });
    return json ? JSON.parse(r.stdout) as { criteria: Array<Record<string, unknown>> } : r.stdout;
  };
  const MIXED = { content_chunks: 3, tags: 1, decide_state: 2, decide_spend: 1, 'pages:updateSlug': 4, 'pages:softDeletePage': 1, raw_sql: 2, takes: 0, facts: 'x', other: 5,
    timeline_entries: 2, wanted_links: 3, page_retrievals: 1, persistence_effects: 4, 'no_row:declarePersistence': 6, 'unmapped:insertFactPurge': 1 };
  const MIXED_LINES = [
    'chunks: sampled 3 (content_chunks 3)',
    'tags: sampled 1 (tags 1)',
    'aliases: not sampled',
    'timeline entries: sampled 2 (timeline_entries 2)',
    'takes: not sampled',
    'facts: not sampled',
    'fact withdrawals: not sampled separately (counted under pages:updateSlug 4)',
    'open loops: not sampled',
    'sources: not sampled',
    'owner-only marks: not sampled',
    'decide store: sampled 3 (decide_state 2, decide_spend 1)',
    'side tables: sampled 4 (wanted_links 3, page_retrievals 1)',
    'process bookkeeping: sampled 4 (persistence_effects 4)',
    'no row written: sampled 6 (no_row:declarePersistence 6)',
    'other write families sampled: pages:updateSlug 4, pages:softDeletePage 1, raw_sql 2, other 5, unmapped:insertFactPurge 1',
    NOT_VERIFIED,
    NAMED_LOSS,
    TABLE_LOSS,
  ];

  test('some families sampled and some not give exactly these lines, in the JSON row and in the text report', async () => {
    const row = ((await plan(sampled(MIXED), true)) as { criteria: Array<Record<string, unknown>> }).criteria.find(c => c.n === 5)!;
    expect(row.lines).toEqual(MIXED_LINES);
    const text = (await plan(sampled(MIXED), false)) as string;
    expect(text).toContain(`\n${MIXED_LINES.map(l => `       ${l}`).join('\n')}\n`);
  });

  test('with nothing sampled every named type reads not sampled and the other line reads none', async () => {
    const row = ((await plan(sampled({}), true)) as { criteria: Array<Record<string, unknown>> }).criteria.find(c => c.n === 5)!;
    expect(row.lines).toEqual([
      'chunks: not sampled', 'tags: not sampled', 'aliases: not sampled', 'timeline entries: not sampled', 'takes: not sampled', 'facts: not sampled',
      'fact withdrawals: not sampled separately (counted under pages:updateSlug 0)',
      'open loops: not sampled', 'sources: not sampled', 'owner-only marks: not sampled', 'decide store: not sampled',
      'side tables: not sampled', 'process bookkeeping: not sampled', 'no row written: not sampled',
      'other write families sampled: none', NOT_VERIFIED, NAMED_LOSS, TABLE_LOSS,
    ]);
  });

  test('the JSON row only gains lines: the old keys and the old sentence are unchanged, and no other criterion has lines', async () => {
    const doc = (await plan(sampled(MIXED), true)) as { criteria: Array<Record<string, unknown>> };
    const row = doc.criteria.find(c => c.n === 5)!;
    expect(Object.keys(row).sort()).toEqual(['detail', 'gating', 'lines', 'n', 'name', 'state']);
    expect(row.state).toBe('fail');
    expect(String(row.detail).endsWith(WRITE_COVERAGE_NAMED)).toBe(true);
    expect(String(row.detail)).toContain('sampled so far: content_chunks 3, tags 1, decide_state 2, decide_spend 1, pages:updateSlug 4, pages:softDeletePage 1, raw_sql 2, other 5, timeline_entries 2, wanted_links 3, page_retrievals 1, persistence_effects 4, no_row:declarePersistence 6, unmapped:insertFactPurge 1');
    expect(String(row.detail)).not.toContain('Named loss');
    expect(doc.criteria.filter(c => c.n !== 5 && 'lines' in c)).toEqual([]);
  });

  test('the sentence, the guide and the named loss are pinned', () => {
    expect(WRITE_COVERAGE_NAMED).toBe('Criterion 5 covers the pilot page and link writes (putPage, deletePage, addLink, addLinksBatch, removeLink) only (#10350, #10360, #10382, #10390). These write types are not compared and get named lines in the swap report: chunks, tags, aliases, timeline entries, takes, facts, fact withdrawals, open loops, sources, owner-only marks and the decide store.');
    const guide = readFileSync(join(import.meta.dir, '..', 'docs', 'guides', 'engine-swap.md'), 'utf8');
    expect(guide).toContain(WRITE_COVERAGE_NAMED);
    expect(guide).toContain(NAMED_LOSS);
    expect(WRITE_NOT_VERIFIED).toBe(NOT_VERIFIED);
    expect(WRITE_TABLE_LOSS).toBe(TABLE_LOSS);
    expect(guide).toContain(TABLE_LOSS);
    expect(guide).toContain('The next line says `named, not verified`');
  });

  test('the table loss names exactly the tables the side and bookkeeping lines read, plus the named types raw writes reach', () => {
    const named = TABLE_LOSS.match(/\b[a-z]+(?:_[a-z]+)+\b/g)!.filter(t => !['raw_sql', 'no_row'].includes(t));
    expect(new Set(named)).toEqual(new Set(['timeline_entries', 'takes', 'sources', ...WRITE_SIDE_TABLES, ...WRITE_BOOKKEEPING_TABLES].filter(t => t.includes('_'))));
    expect(TABLE_LOSS).toContain('timeline_entries, takes and sources');
    expect(WRITE_SIDE_TABLES.filter(t => WRITE_BOOKKEEPING_TABLES.includes(t))).toEqual([]);
  });

  test('classifying raw_sql and unmapped samples moves no comparable count: state, the bar part of the detail and the bar are unchanged', async () => {
    // Run A on PG17 (575 comparable, 2,559 raw and 4,263 unmapped samples): the same totals, before and after naming them.
    const before = { raw_sql: 2559, unmapped: 4263 };
    const named: Record<string, number> = { timeline_entries: 600, takes: 200, wanted_links: 400, sources: 6, persistence_effects: 1000, persistence_requests: 752, persistence_counters: 685,
      page_retrievals: 60, 'no_row:declarePersistence': 1773, 'no_row:lockEffectGuard': 600, 'pages:sealImportedPage': 200, 'unmapped:insertFactPurge': 1 };
    const after = { ...named, raw_sql: 2559 + 4263 - Object.values(named).reduce((a, b) => a + b, 0) };
    expect(after.raw_sql).toBeGreaterThan(0);
    const doc = (byFamily: Record<string, number>) => ({
      write_comparisons: { state: 'measured', sample_rate: 1, comparable: 575, unexplained_difference: 0, uncomparable: 0, capability_missing: 6822, capability_missing_by_family: byFamily },
    }) as unknown as ShadowStatus;
    const rows = await Promise.all([before, after].map(async b => ((await plan(doc(b), true)) as { criteria: Array<Record<string, unknown>> }).criteria.find(c => c.n === 5)!));
    for (const row of rows) {
      expect(row.state).toBe('fail');
      expect(String(row.detail).startsWith('575 of 1000 comparable write comparisons; ')).toBe(true);
      // Only the not-verified line speaks of the comparable count or the bar, and it says none of these counts toward them.
      expect((row.lines as string[]).filter(l => /comparable|write bar|toward/.test(l))).toEqual([NOT_VERIFIED]);
    }
    expect(rows[0]!.gating).toEqual(rows[1]!.gating);
  });

  test('the named loss names every page and link write that is not a pilot write, and no other', () => {
    // The set the code counts as capability_missing under pages:<op> or links:<op>: the family writeFamily gives each non-pilot WRITE_MAP member.
    const fromCode = Object.keys(WRITE_MAP).filter(op => !PILOT_WRITES.has(op)).map(op => writeFamily(op)).filter(f => /^(pages|links):/.test(f));
    // A typed member outside the map whose statements write pages is named the same way (sealImportedPage).
    fromCode.push(writeFamily('sealImportedPage', sampledStatements('sealImportedPage', [])));
    expect(fromCode.length).toBe(25);
    const guide = readFileSync(join(import.meta.dir, '..', 'docs', 'guides', 'engine-swap.md'), 'utf8');
    // WRITE_COVERAGE_LOSS is the evaluated string, so the guide holds the same text with no source escape.
    // The guide mentions pages:updateSlug elsewhere (the fact withdrawals line), so read only its named-loss paragraph.
    const guideLoss = guide.slice(guide.indexOf('Named loss:')).split('\n')[0]!;
    expect(guideLoss).toBe(WRITE_COVERAGE_LOSS);
    for (const text of [WRITE_COVERAGE_LOSS, guideLoss]) {
      const named = text.match(/\b(?:pages|links):[A-Za-z]\w*/g) ?? [];
      expect(named.length).toBe(fromCode.length);
      expect(new Set(named)).toEqual(new Set(fromCode));
    }
    // The sentence names exactly the five pilot writes.
    const pilot = /the pilot page and link writes \(([^)]*)\) only/.exec(WRITE_COVERAGE_NAMED)![1]!.split(', ');
    expect(new Set(pilot)).toEqual(new Set(PILOT_WRITES));
    expect(WRITE_COVERAGE_NAMED).not.toContain('covers page and link writes only');
  });

  test('the short coverage sentence says the pilot writes, in the report, the status line, the guide and ENGINES.md', () => {
    expect(WRITE_COVERAGE_LIMIT).toBe('a criterion 5 pass covers the pilot page and link writes only');
    const docs = ['docs/guides/engine-swap.md', 'docs/ENGINES.md', 'llms-full.txt'].map(f => readFileSync(join(import.meta.dir, '..', f), 'utf8'));
    expect(docs[0]).toContain(`**A criterion 5 pass covers the pilot page and link writes only.**`);
    expect(docs[0]).toContain('so a criterion 5 pass still covers the pilot page and link writes only');
    for (const doc of docs.slice(1)) {
      expect(doc).toContain('`write_comparisons` (the pilot page and link writes only;');
      expect(doc).toContain('write comparisons cover the pilot page and link writes only');
    }
    for (const doc of docs) expect(doc).not.toMatch(/(?:covers?|\() ?page and link writes only/);
  });

  test('every write family a non-pilot write is counted under is named, a pages or links key, or on the other line', () => {
    const named = new Set(['content_chunks', 'tags', 'page_aliases', 'timeline_entries', 'takes', 'facts', 'open_loops', 'sources', 'owner_only_marks',
      'decide_state', 'decide_spend', 'decision_receipts', 'decide_calibrations', 'decide_proposals', 'decide_review_proposals', 'decide_review_queue', 'decide_sweep_deferred']);
    // The other line carries these, so the lines name them as sampled and no count is dropped.
    // The side tables and bookkeeping lines carry these.
    const grouped = new Set([...WRITE_SIDE_TABLES, ...WRITE_BOOKKEEPING_TABLES]);
    const other = new Set(['raw_sql', 'unmapped', 'other', 'config', 'entity_identities', 'raw_data', 'files', 'page_versions', 'synthesis_evidence', 'code_edges_chunk']);
    const stray = Object.keys(WRITE_MAP).filter(op => !PILOT_WRITES.has(op)).map(op => writeFamily(op))
      .filter(f => !named.has(f) && !grouped.has(f) && !other.has(f) && !/^(pages|links):[A-Za-z]+$/.test(f));
    expect(stray).toEqual([]);
    // No named type is also on the other line, and fact withdrawals never has a family of its own.
    expect([...other].filter(f => named.has(f) || grouped.has(f))).toEqual([]);
    expect([...grouped].filter(f => named.has(f))).toEqual([]);
    expect(Object.keys(WRITE_MAP).map(op => writeFamily(op))).not.toContain('fact_withdrawals');
  });
});

describe('A1: the swap check waits a bounded 60 s for a moment when every sample is settled', () => {
  const BUSY = 'brain busy: no 60 s lull with all samples settled; retry when idle';
  const doc = (unresolved: number) => ({
    write_comparisons: { state: unresolved ? 'capability_missing' : 'measured', sample_rate: 1, comparable: 5000, unexplained_difference: 0, uncomparable: 0, capability_missing: 0, ...(unresolved ? { unresolved_replays: unresolved } : {}) },
  }) as unknown as ShadowStatus;
  /** A clock the fake sleep advances: the wait costs no real time. */
  function clockRig() { let t = 1_000_000; const sleeps: number[] = []; return { sleeps, clock: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; } }; }
  const crit5 = (stdout: string) => (JSON.parse(stdout) as { criteria: Array<{ n: number; state: string; detail: string }> }).criteria.find((c) => c.n === 5)!;

  test('a brain that is never settled for 60 s refuses criterion 5 with exactly "brain busy: no 60 s lull with all samples settled; retry when idle", after waiting 60 s and no longer', async () => {
    const rig = clockRig(); let reads = 0;
    const r = await run(['--to', 'rust', '--plan', '--json'], { readShadowStatus: async () => { reads++; return doc(2); }, clock: rig.clock, sleep: rig.sleep });
    const c = crit5(r.stdout);
    expect(c.state).toBe('missing');
    expect(c.detail.startsWith(BUSY)).toBe(true); // verbatim
    expect(c.detail).toContain('the child keeps up only below ~19 samples/s on this VM'); // the limit is named in the report
    expect(rig.sleeps.reduce((a, b) => a + b, 0)).toBe(60_000); // a constant 60 s, not a setting
    expect(reads).toBe(61);
  });

  test('a brain with a lull passes on its first settled read: it stops waiting at once and reads criterion 5 from that read', async () => {
    const rig = clockRig(); let reads = 0;
    const r = await run(['--to', 'rust', '--plan', '--json'], { readShadowStatus: async () => doc(++reads < 3 ? 1 : 0), clock: rig.clock, sleep: rig.sleep });
    const c = crit5(r.stdout);
    expect(reads).toBe(3); // the first read with nothing unsettled
    expect(rig.sleeps).toHaveLength(2);
    expect(c.detail).not.toContain('brain busy');
    expect(c.state).toBe('pass');
  });

  test('a settled status, or no shadow at all, is read once and never waits', async () => {
    const rig = clockRig(); let reads = 0;
    await run(['--to', 'rust', '--plan', '--json'], { readShadowStatus: async () => { reads++; return doc(0); }, clock: rig.clock, sleep: rig.sleep });
    expect([reads, rig.sleeps.length]).toEqual([1, 0]);
    await run(['--to', 'rust', '--plan', '--json'], { readShadowStatus: async () => null, clock: rig.clock, sleep: rig.sleep });
    expect(rig.sleeps.length).toBe(0);
  });
});
