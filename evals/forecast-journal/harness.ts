#!/usr/bin/env bun
/**
 * W7 forecast-journal gate runner ($0, synthetic, no key, no network).
 *
 * CHECK mode:
 *   bun evals/forecast-journal/harness.ts --check
 * The generator's output hash equals the one PREREGISTRATION.md froze, the
 * cohort shapes match the constants, and every holder and topic is a
 * placeholder. Exit 1 on any violation.
 *
 * RUN mode:
 *   bun evals/forecast-journal/harness.ts --run [--json summary.json] [--md summary.md]
 * Loads every cohort into one in-memory PGLite brain (one source per
 * cohort; takes written through the engine, so no belief ledger and every
 * prediction time is the uncertified since_date), applies the stated-horizon
 * scan, then measures through the production readers (readForecastJournal,
 * scorecardGroups, the takes_* op handlers) what PREREGISTRATION.md names and
 * applies its decision rule. Exit 0 pass, 1 fail.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AS_OF, cohorts, fixturesSha256, LOW_N, REPLICATES, SKILLED_HOLDERS, LOW_N_HOLDERS, TOPICS, whoWasRight, type Cohort } from './fixtures.ts';
import { decide, median, RHO_MIN, setF1, spearman, type GateResult } from './score.ts';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1] ?? null; };
const here = import.meta.dir;

export function checkInstrument(): string[] {
  const out: string[] = [];
  const pinned = /fixtures sha256: `([0-9a-f]{64})`/.exec(readFileSync(join(here, 'PREREGISTRATION.md'), 'utf8'))?.[1];
  if (pinned !== fixturesSha256()) out.push(`generator output ${fixturesSha256()} differs from the frozen ${pinned ?? '(none)'}`);
  const all = cohorts();
  if (all.length !== REPLICATES) out.push(`${all.length} cohorts, expected ${REPLICATES}`);
  for (const c of all) {
    if (c.holders.length !== SKILLED_HOLDERS + LOW_N_HOLDERS) out.push(`${c.source_id}: ${c.holders.length} holders`);
    for (const h of c.holders) {
      if (!/^holder-\d{2}-example$/.test(h.holder)) out.push(`${c.source_id}: holder ${h.holder} is not a placeholder`);
      const resolved = c.predictions.filter(p => p.holder === h.holder && p.state === 'resolved').length;
      if (resolved !== h.resolved) out.push(`${c.source_id}: ${h.holder} has ${resolved} resolved, declared ${h.resolved}`);
      if (h.skill === null ? h.resolved !== LOW_N : h.resolved < 10) out.push(`${c.source_id}: ${h.holder} n=${h.resolved} is off its shape`);
    }
    for (const p of c.predictions) if (!/^companies\/topic-\d{3}-example$/.test(p.topic)) out.push(`${c.source_id}: topic ${p.topic} is not a placeholder`);
  }
  return out;
}

async function run(): Promise<{ result: GateResult; decision: ReturnType<typeof decide>; meta: Record<string, unknown> }> {
  const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
  const { scanStatedHorizons } = await import('../../src/core/takes-horizon.ts');
  const { readForecastJournal, scorecardGroups } = await import('../../src/core/forecast-journal.ts');
  const { operationsByName } = await import('../../src/core/operations.ts');
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const asOf = new Date(AS_OF);
  const all = cohorts();
  try {
    for (const c of all) await load(engine, c);
    const first = all[0]!;
    const local = { engine, sourceId: first.source_id, remote: false, dryRun: false,
      config: { engine: 'pglite', embedding_disabled: true }, logger: { info() {}, warn() {}, error() {} } } as never as Record<string, unknown>;
    const remote = { ...local, remote: true, auth: { token: 't', clientId: 'fj-probe', scopes: ['read'], sourceId: first.source_id },
      takesHoldersAllowList: first.holders.map(h => h.holder) };
    const call = async (ctx: Record<string, unknown>, op: string, params: Record<string, unknown>) => JSON.stringify(await operationsByName[op]!.handler(ctx as never, params));
    const surfaces = async () => ({
      list: await call(remote, 'takes_list', {}), search: await call(remote, 'takes_search', { query: 'milestone' }),
      card: await call(remote, 'takes_scorecard', {}), localCard: await call(local, 'takes_scorecard', {}),
    });
    const before = await surfaces();
    const scan = await scanStatedHorizons(engine, { apply: true });
    const after = await surfaces();

    const rhoShrunk: number[] = [], rhoRaw: number[] = [], f1s: number[] = [];
    const denominator: string[] = [], lowN: string[] = [], labelling: string[] = [];
    for (const c of all) {
      const groups = await scorecardGroups(engine, { groupBy: 'holder', minN: 10, sourceId: c.source_id, asOf });
      const by = new Map(groups.map(g => [g.key, g]));
      const skilled = c.holders.filter(h => h.skill !== null);
      rhoShrunk.push(spearman(skilled.map(h => h.skill!), skilled.map(h => by.get(h.holder)!.accuracy_shrunk!)));
      rhoRaw.push(spearman(skilled.map(h => h.skill!), skilled.map(h => by.get(h.holder)!.accuracy!)));
      for (const h of c.holders) {
        const g = by.get(h.holder);
        if (!g) { denominator.push(`${c.source_id}/${h.holder}: no group`); continue; }
        if (g.low_n !== (h.resolved < 10)) lowN.push(`${c.source_id}/${h.holder}: low_n ${g.low_n} at n=${h.resolved}`);
        const mine = c.predictions.filter(p => p.holder === h.holder);
        const want = { n: h.resolved, unresolved: mine.length - h.resolved, overdue: mine.filter(p => p.state === 'overdue').length, open: mine.filter(p => p.state === 'open').length };
        const got = { n: g.n, unresolved: g.unresolved, overdue: g.overdue, open: g.open };
        if (JSON.stringify(want) !== JSON.stringify(got)) denominator.push(`${c.source_id}/${h.holder}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
      }
      const journal = await readForecastJournal(engine, { sourceId: c.source_id, asOf });
      const count = (s: string) => c.predictions.filter(p => p.state === s).length;
      const wantTotals = { predictions: c.predictions.length, resolved: count('resolved'), unresolved: c.predictions.length - count('resolved'),
        open: count('open'), overdue: count('overdue'), undated: count('undated'), certified_prediction_times: 0 };
      if (JSON.stringify(journal.totals) !== JSON.stringify(wantTotals)) denominator.push(`${c.source_id}: totals ${JSON.stringify(journal.totals)} != ${JSON.stringify(wantTotals)}`);
      const since = new Map(c.predictions.map(p => [p.claim, p.since]));
      for (const e of journal.entries) {
        if (JSON.stringify(e.prediction) !== JSON.stringify({ at: since.get(e.claim), basis: 'since_date', certified: false })) labelling.push(`${c.source_id}: ${e.claim} ${JSON.stringify(e.prediction)}`);
      }
      for (const [topic, gold] of whoWasRight(c)) {
        const resolved = await readForecastJournal(engine, { sourceId: c.source_id, asOf, about: topic, state: 'resolved' });
        f1s.push(setF1(gold, new Set(resolved.entries.filter(e => e.resolution?.quality === 'correct').map(e => e.holder))));
      }
    }

    const refused = async (params: Record<string, unknown>) => {
      try { await call(remote, 'takes_scorecard', params); return { pass: false, detail: 'answered' }; }
      catch (e) { const code = (e as { code?: string }).code; return { pass: code === 'scorecard_group_by_local_only', detail: String(code) }; }
    };
    const noKeys = (json: string, keys: string[]) => keys.filter(k => json.includes(`"${k}"`));
    const probes: GateResult['remote_probes'] = [
      { probe: 'remote takes_list unchanged by horizons, no journal fields', pass: after.list !== '[]' && before.list === after.list && noKeys(after.list, ['horizon', 'horizon_date', 'prediction', 'journal']).length === 0, detail: `${after.list.length} bytes` },
      { probe: 'remote takes_search unchanged by horizons, no journal fields', pass: after.search !== '[]' && before.search === after.search && noKeys(after.search, ['horizon', 'horizon_date', 'prediction', 'journal']).length === 0, detail: `${after.search.length} bytes` },
      { probe: 'remote takes_scorecard {} unchanged, no groups or journal', pass: !after.card.includes('"total_bets":0,') && before.card === after.card && noKeys(after.card, ['groups', 'journal']).length === 0, detail: after.card },
      { probe: 'local takes_scorecard {} unchanged by horizons', pass: before.localCard === after.localCard, detail: `${after.localCard.length} bytes` },
      { probe: 'remote takes_scorecard {group_by: holder} refused', ...(await refused({ group_by: 'holder' })) },
      { probe: 'remote takes_scorecard {group_by: source} refused', ...(await refused({ group_by: 'source' })) },
      { probe: 'remote takes_scorecard {min_n: 5} refused', ...(await refused({ min_n: 5 })) },
      { probe: 'no MCP op reads the journal or horizons', pass: !Object.keys(operationsByName).some(n => /journal|horizon/.test(n)), detail: Object.keys(operationsByName).filter(n => /journal|horizon/.test(n)).join(',') || 'none' },
    ];
    const result: GateResult = {
      rho_shrunk: rhoShrunk, rho_raw: rhoRaw, median_rho_shrunk: median(rhoShrunk), median_rho_raw: median(rhoRaw),
      share_rho_shrunk_at_least_min: rhoShrunk.filter(r => r >= RHO_MIN).length / rhoShrunk.length,
      set_f1_macro: f1s.reduce((a, b) => a + b, 0) / f1s.length,
      denominator_mismatches: denominator, low_n_mismatches: lowN, labelling_mismatches: labelling, remote_probes: probes,
    };
    return { result, decision: decide(result), meta: {
      fixtures_sha256: fixturesSha256(), cohorts: all.length, predictions: all.reduce((a, c) => a + c.predictions.length, 0),
      topics_scored: f1s.length, horizons_written: scan.written, horizons_unparsed: scan.unparsed, as_of: AS_OF, bun: Bun.version,
    } };
  } finally {
    await engine.disconnect();
  }
}

async function load(engine: import('../../src/core/engine.ts').BrainEngine, c: Cohort): Promise<void> {
  await engine.executeRaw('INSERT INTO sources(id, name) VALUES ($1, $1)', [c.source_id]);
  const pageIds = new Map<string, number>();
  for (let t = 1; t <= TOPICS; t++) {
    const slug = `companies/topic-${String(t).padStart(3, '0')}-example`;
    const page = await engine.putPage(slug, { type: 'company', title: slug.slice(10), compiled_truth: `${slug.slice(10)} is a synthetic company.` }, { sourceId: c.source_id });
    pageIds.set(slug, Number(page.id));
  }
  const rowsByPage = new Map<string, number>();
  const rows = c.predictions.map(p => {
    const row_num = (rowsByPage.get(p.topic) ?? 0) + 1;
    rowsByPage.set(p.topic, row_num);
    return { page_id: pageIds.get(p.topic)!, row_num, claim: p.claim, kind: p.kind, holder: p.holder, weight: p.weight, since_date: p.since };
  });
  await engine.addTakesBatch(rows);
  const resolutions = c.predictions.map((p, i) => ({ p, r: rows[i]! })).filter(x => x.p.outcome !== null)
    .map(({ p, r }) => ({ page_id: r.page_id, row_num: r.row_num, quality: p.outcome, at: p.resolved_at, src: p.resolved_source }));
  await engine.executeRaw(
    `UPDATE takes t SET resolved_at = x.at::timestamptz, resolved_quality = x.quality, resolved_outcome = (x.quality = 'correct'), resolved_by = 'owner', resolved_source = x.src
       FROM jsonb_to_recordset($1::jsonb) AS x(page_id int, row_num int, quality text, at text, src text)
      WHERE t.page_id = x.page_id AND t.row_num = x.row_num`, [JSON.stringify(resolutions)]);
}

export function renderMarkdown(r: GateResult, d: ReturnType<typeof decide>, meta: Record<string, unknown>): string {
  const f = (x: number) => x.toFixed(3);
  return [
    `# W7 forecast-journal gate: ${d.pass ? 'PASS' : 'FAIL'}`, '',
    `${meta.cohorts} cohorts, ${meta.predictions} predictions, fixtures sha256 \`${meta.fixtures_sha256}\`, as of ${meta.as_of}.`, '',
    '| Criterion | Threshold | Result |', '|---|---|---|',
    `| Median Spearman rho, shrunk accuracy vs true skill (12 holders, n >= 10) | >= ${RHO_MIN} | ${f(r.median_rho_shrunk)} (${Math.round(r.share_rho_shrunk_at_least_min * 100)}% of cohorts >= ${RHO_MIN}; raw accuracy ${f(r.median_rho_raw)}) |`,
    `| Who-was-right set-F1, macro over ${meta.topics_scored} topics | >= 0.95 | ${f(r.set_f1_macro)} |`,
    `| Denominator (journal totals and per-holder counts) | exact | ${r.denominator_mismatches.length} mismatches |`,
    `| low_n flags | exact | ${r.low_n_mismatches.length} mismatches |`,
    `| Prediction times labelled since_date, uncertified | exact | ${r.labelling_mismatches.length} mismatches |`,
    `| Remote probes | all pass | ${r.remote_probes.filter(p => p.pass).length}/${r.remote_probes.length} |`, '',
    ...r.remote_probes.map(p => `- ${p.pass ? 'pass' : 'FAIL'}: ${p.probe}`), '',
    `Per-cohort rho (shrunk): ${r.rho_shrunk.map(f).join(', ')}`, '',
    ...(d.failed.length ? ['Failed:', ...d.failed.map(x => `- ${x}`)] : []),
  ].join('\n') + '\n';
}

if (import.meta.main) {
  if (args.includes('--check')) {
    const violations = checkInstrument();
    for (const v of violations) console.error(`CHECK: ${v}`);
    console.log(violations.length ? `${violations.length} violation(s)` : `instrument ok: ${REPLICATES} cohorts, fixtures sha256 ${fixturesSha256()}`);
    process.exit(violations.length ? 1 : 0);
  }
  if (args.includes('--run')) {
    const violations = checkInstrument();
    if (violations.length) { for (const v of violations) console.error(`CHECK: ${v}`); process.exit(1); }
    const { result, decision, meta } = await run();
    const md = renderMarkdown(result, decision, meta);
    if (flag('--json')) writeFileSync(flag('--json')!, JSON.stringify({ meta, result, decision }, null, 2) + '\n');
    if (flag('--md')) writeFileSync(flag('--md')!, md);
    console.log(md);
    process.exit(decision.pass ? 0 : 1);
  }
  console.error('Usage: bun evals/forecast-journal/harness.ts --check | --run [--json <file>] [--md <file>]');
  process.exit(2);
}
