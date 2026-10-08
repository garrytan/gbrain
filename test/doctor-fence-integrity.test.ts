/**
 * #6188 PR3 doctor `fence_integrity` (src/commands/doctor/checks/fence-integrity.ts).
 *
 * Protects: doctor reports every malformed facts or takes fence that waits
 * (held file, stored page, unsynced file) per source, split by planned tier,
 * with the oldest hold and the `gbrain repair fences --source <id>` preview as
 * the fix for every bucket (#6188 PR4); what the next maintenance run repairs
 * is described as "repaired automatically by the next maintenance run" only
 * while one is active, otherwise the preview then the apply; model-tier
 * fences say why they wait (fences.repair.llm off, budget spent); a census
 * the bounded scan did not finish is partial and never ok; the 7-day
 * normalization trend warns at FENCE_NORMALIZATION_WARN_7D and not below,
 * naming the top writers; the model-repair caps and today's ledger spend are
 * shown; the WAVE_CHECKS entry counts details.total; output is location only.
 * Fails when: a partial or stale census reads ok, counts double a page found
 * twice, the trend threshold is off by one, the fix keeps the edit-and-sync
 * step, "no action needed" appears with no maintenance run, or a cell value
 * reaches the check.
 * PGLite in-memory ($0); synthetic content only.
 *
 * #6278 (2.3): legacy fact rows the fence step cannot adopt are counted under
 * `unrenderable_legacy_facts` from the planner's read-only result (pages,
 * fact ids and reason classes, never the claim), the message says the rows
 * stay active and searchable and nothing is lost and never suggests
 * forgetting them, the fix has no command (`next: report`) and its verify
 * re-counts the rows; a brain with none stays ok. Fails when: the count
 * comes from a receipt (none exists for a row never submitted), the claim
 * text reaches the output, or the fix tells the agent to run something.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { DOCTOR_CHECK_REGISTRY } from '../src/commands/doctor/registry.ts';
import { FENCE_NORMALIZATION_WARN_7D, fenceIntegrityResult } from '../src/commands/doctor/checks/fence-integrity.ts';
import { writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { recordWriteTrend } from '../src/core/fence-repair/census-store.ts';
import { dailyLedger, FENCE_REPAIR_LEDGER } from '../src/core/budget/daily-ledger.ts';
import { WAVE_CHECKS, remoteWaveHandoff } from '../src/commands/doctor/wave-checks.ts';
import { bannerFindingLine } from '../src/commands/doctor/upgrade-banner.ts';
import { repairForCheck } from '../src/core/repair/registry.ts';
import { LAST_GLOBAL_MAINTENANCE_KEY } from '../src/core/fence-repair/hold-fix.ts';
import { LAST_GLOBAL_AT_KEY } from '../src/core/cycle.ts';
import { cliRenderContext, renderAction } from '../src/core/agent-output.ts';

const T = '<!--- gbrain:takes:begin -->', TE = '<!--- gbrain:takes:end -->';
const TH = '| # | claim | kind | who | weight | since | source |\n|---|---|---|---|---|---|---|';
const FB = '<!--- gbrain:facts:begin -->', FE = '<!--- gbrain:facts:end -->';
const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|';
const CLAIM = 'Sentinelclaimzq6 renews yearly', HOLDER = 'Sentinelholderzq6 Example', KIND = 'sentinelkindzq6';
const SECRETS = [CLAIM, HOLDER, KIND, 'Sentinelclaimzq6', 'Sentinelholderzq6'];
const row = (n: number, claim: string) => `| ${n} | ${claim} | fact | 1.0 | private | medium | 2026-01-01 |  | call |  |`;
const RESOLVER = `${T}\n${TH}\n| 1 | ${CLAIM} | take | ${HOLDER} | 0.7 | 2026-01 | chat |\n${TE}\n`;
const MANUAL = `${T}\n${TH}\n| 1 | Synthetic take | ${KIND} | brain | 0.7 | 2026-01 | chat |\n${TE}\n`;
const LLM = `${FB}\n${row(1, 'Synthetic fact')}\n${row(2, 'Another synthetic fact')}\n${FE}\n`;
const DETERMINISTIC = `${FB}\n${FH}\n${row(1, 'Synthetic fact')}\n${row(2, 'Second synthetic fact')}\n\n`;
const CLEAN = `${FB}\n${FH}\n${row(1, 'Clean synthetic fact')}\n${FE}\n`;

let engine: PGLiteEngine;
const roots: string[] = [];
const NOW = new Date('2026-10-06T12:00:00Z');

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => { await engine.disconnect(); for (const root of roots) rmSync(root, { recursive: true, force: true }); }, 60_000);

// Every test reads the whole brain, so each one starts with only its own sources live.
afterEach(async () => {
  await engine.executeRaw("UPDATE sources SET archived=true WHERE id<>'default'");
  for (const key of ['fences.repair.max_usd_per_day', 'fences.repair.max_usd_per_page', 'fences.repair.llm', 'fences.repair.enabled', LAST_GLOBAL_AT_KEY]) await engine.unsetConfig(key);
});

async function source(files: Record<string, string> = {}) {
  const id = `fi-${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const root = mkdtempSync(join(tmpdir(), 'fence-integrity-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); }
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, root]);
  const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [id]);
  return { id, root, incarnation };
}
const md = (title: string, body: string) => `---\ntitle: ${title}\n---\n${body}`;
const stored = (sourceId: string, slug: string, body: string) => engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body, timeline: '' }, { sourceId });
const result = (opts: { timeoutMs?: number } = {}) => fenceIntegrityResult(engine, { timeoutMs: opts.timeoutMs ?? 60_000, now: () => NOW });

describe('fence_integrity doctor check', () => {
  test('is registered before search_mode and categorized as a brain check', () => {
    const names = DOCTOR_CHECK_REGISTRY.map(entry => entry.name);
    expect(names.indexOf('fence_integrity')).toBe(names.indexOf('search_mode') - 1);
    expect(categorizeCheck('fence_integrity')).toBe('brain');
  });

  test('a brain whose fences all parse is ok once the census is complete', async () => {
    const s = await source({ 'notes/clean.md': md('Clean', CLEAN) });
    await stored(s.id, 'notes/clean', CLEAN);
    const check = await result();
    expect(check.status).toBe('ok');
    expect(check.details).toMatchObject({ total: 0, partial: false, warn_at_normalized_7d: FENCE_NORMALIZATION_WARN_7D });
  });

  test('counts each waiting fence once per source by bucket and tier, names the oldest hold and the fence repair preview', async () => {
    const s = await source({ 'notes/held.md': md('Held', MANUAL), 'notes/both.md': md('Both', RESOLVER), 'notes/unsynced.md': md('Unsynced', LLM) });
    await stored(s.id, 'notes/both', RESOLVER);
    await stored(s.id, 'notes/db-only', DETERMINISTIC);
    await engine.transaction(tx => writeGitHold(tx, { source_id: s.id, incarnation: s.incarnation, path: 'notes/held.md', source_path: 'notes/held.md', slug: 'notes/held',
      page_id: null, code: 'invalid_fence', message: 'Fence takes_kind_unsupported: in the takes fence (body), row 1, column kind.', upstream_version: 'v1',
      observed_at: new Date().toISOString(), run_id: 'run-1', mode: 'managed',
      meta: { reason: 'takes_kind_unsupported', recovery_version: 1, fence_version: 1, fence: { reason: 'takes_kind_unsupported', fence: 'takes', section: 'body', rows: [1], columns: ['kind'], line: 4 } } }));
    const check = await result();
    expect(check.status).toBe('warn');
    const details = check.details as any;
    expect(details.total).toBe(4);
    expect(details.sources.find((c: any) => c.source_id === s.id)).toMatchObject({ total: 4, holds: { manual: 1, total: 1 }, pages: { resolver: 1, deterministic: 1, total: 2 },
      files: { llm: 1, total: 1 }, by_tier: { deterministic: 1, resolver: 1, llm: 1, manual: 1, total: 4 } });
    expect(check.message).toContain(`${s.id}: 1 held file(s), 2 stored page(s), 1 unsynced file(s) (by tier: deterministic 1, resolver 1, llm 1, manual 1); oldest hold`);
    expect(check.message).toContain('Model repair caps: $0.30 per page, $1.00 per day ($0.00 spent today).');
    // No maintenance run has completed on this brain: never "repaired automatically", the preview then the apply.
    expect(check.message).toContain('not repaired automatically (no maintenance run has completed in the last 24 h)');
    expect(check.message).toContain(`Preview: gbrain repair fences --source ${s.id}`);
    expect(check.fix).toMatchObject({ argv: ['gbrain', 'repair', 'fences', '--source', s.id], actor: 'agent',
      then: { argv: ['gbrain', 'repair', 'fences', '--source', s.id, '--apply'] } });
    expect(check.fix!.why).toContain('--expect <hash>');
    expect(check.fix!.why).toContain('1 need a manual edit');
    expect(details.auto_repair).toMatchObject({ enabled: true, llm: true, active: false, last_maintenance_at: null });
    const text = JSON.stringify(check);
    expect(text).not.toContain('repair frontmatter');
    expect(text).not.toContain('after the user agrees');
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  });

  test('a stored-page-only source gets the same preview; with a maintenance run active it is repaired automatically by the next run', async () => {
    const s = await source();
    await stored(s.id, 'notes/db-only', DETERMINISTIC);
    const check = await result();
    expect(check.status).toBe('warn');
    expect(check.fix!.argv).toEqual(['gbrain', 'repair', 'fences', '--source', s.id]);
    await engine.setConfig(LAST_GLOBAL_AT_KEY, new Date(NOW.getTime() - 3_600_000).toISOString());
    const active = await result();
    expect(active.message).toContain('The deterministic, resolver and model-tier ones are repaired automatically by the next maintenance run');
    expect(active.fix).toMatchObject({ argv: ['gbrain', 'repair', 'fences', '--source', s.id] });
    expect(active.fix!.then).toBeUndefined();
    expect(active.fix!.why).toContain('no action is needed');
    // The maintenance stamp is cycle.ts's key; a stamp older than a day is not an active job, and the pause switch wins.
    expect(LAST_GLOBAL_MAINTENANCE_KEY).toBe(LAST_GLOBAL_AT_KEY);
    await engine.setConfig(LAST_GLOBAL_AT_KEY, new Date(NOW.getTime() - 25 * 3_600_000).toISOString());
    expect((await result()).fix!.then?.argv).toEqual(['gbrain', 'repair', 'fences', '--source', s.id, '--apply']);
    await engine.setConfig(LAST_GLOBAL_AT_KEY, NOW.toISOString());
    await engine.setConfig('fences.repair.enabled', 'false');
    expect((await result()).message).toContain('not repaired automatically (fences.repair.enabled is false)');
  });

  test('model-tier fences say why they wait: model repair off, or today\'s budget spent', async () => {
    const s = await source();
    await stored(s.id, 'notes/model', LLM);
    await engine.setConfig('fences.repair.llm', 'false');
    const off = await result();
    expect(off.message).toContain('Model repair (Tier 3) is off (fences.repair.llm false), so 1 model-tier fence(s) wait');
    expect(off.message).toContain('gbrain config set fences.repair.llm true');
    expect(off.message).toContain('The deterministic and resolver ones are');
    await engine.unsetConfig('fences.repair.llm');
    await engine.setConfig('fences.repair.max_usd_per_day', '0.1');
    const day = new Date('2026-10-03T12:00:00Z');
    const ledger = dailyLedger(engine, FENCE_REPAIR_LEDGER, { now: () => day });
    const held = await ledger.reserve(0.1, { capUsd: 0.1 });
    if (!held.ok) throw new Error('expected a reservation');
    await ledger.dispatch(held.reservation.id);
    await ledger.settle(held.reservation.id, 0.1);
    const spent = await fenceIntegrityResult(engine, { timeoutMs: 60_000, now: () => day });
    expect(spent.message).toContain('Today\'s model repair budget is spent ($0.10 of $0.10), so 1 model-tier fence(s) wait until after 00:00 UTC');
    expect(spent.message).toContain('gbrain config set fences.repair.max_usd_per_day <usd>');
  });

  test('the WAVE_CHECKS entry counts details.total, routes to the fences kind and its banner and remote lines say who repairs it, with no path or claim', async () => {
    const spec = WAVE_CHECKS.find(entry => entry.id === 'fence_integrity')!;
    expect(spec).toMatchObject({ resolution: 'repair', registration: 'doctor.ts' });
    expect(spec.hostOnly).toBeUndefined();
    expect(repairForCheck('fence_integrity')?.kind).toBe('fences');
    const s = await source({ 'notes/held.md': md('Held', MANUAL) });
    await stored(s.id, 'notes/db-only', DETERMINISTIC);
    const check = await spec.run(engine, { sourceIds: [s.id] });
    expect(spec.count(check.details ?? {})).toBe(2);
    const line = bannerFindingLine({ spec, check, state: 'finding' });
    expect(line).toBe('[AGENT]   fence_integrity: 2 (not repaired automatically (no maintenance run is active); preview with: gbrain repair fences)');
    await engine.setConfig(LAST_GLOBAL_AT_KEY, new Date().toISOString());
    const active = await spec.run(engine, { sourceIds: [s.id] });
    expect(bannerFindingLine({ spec, check: active, state: 'finding' })).toBe('[AGENT]   fence_integrity: 2 (repaired automatically by the next maintenance run, except 1 that need a manual edit; preview with: gbrain repair fences)');
    const remote = (await remoteWaveHandoff(engine, [s.id])).find(entry => entry.name === 'fence_integrity')!;
    expect(remote).toMatchObject({ status: 'warn', details: { host_action: { check_id: 'fence_integrity', state: 'action_required' } } });
    const text = JSON.stringify(remote);
    for (const leak of ['notes/held', 'notes/db-only', s.root, ...SECRETS]) expect(text).not.toContain(leak);
    for (const blob of [line, JSON.stringify(check)]) for (const secret of SECRETS) expect(blob).not.toContain(secret);
  });

  test('legacy fact rows the fence codec cannot render are counted by page and class with next: report, never the claim (#6278)', async () => {
    const s = await source({ 'people/alice-example.md': md('Alice Example', CLEAN) });
    const page = await stored(s.id, 'people/alice-example', CLEAN);
    await engine.executeRaw('UPDATE pages SET source_path = $1 WHERE id = $2', ['people/alice-example.md', page.id]);
    const STRUCK = '~~Sentinelstruckzq6 left the board~~', TRAILING = 'Sentineltrailingzq6 keeps bees ';
    const insert = (fact: string) => engine.executeRaw<{ id: number }>(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence)
       VALUES ($1, 'people/alice-example', $2, 'fact', 'world', 'medium', '2026-03-01', 'mcp:remember', 0.8) RETURNING id`, [s.id, fact]);
    const [[struck], [blank], [trailing]] = [await insert(STRUCK), await insert('   '), await insert(TRAILING)];
    const check = await result();
    expect(check.status).toBe('warn');
    const found = (check.details as any).unrenderable_legacy_facts;
    // The trailing-whitespace row is adoptable (not counted); the struck and blank rows are not.
    expect(found).toEqual({ total: 2, complete: true, pages: [{ source_id: s.id, slug: 'people/alice-example', rows: [
      { fact_id: Number(struck.id), reason: 'fence_unrenderable', class: 'struck' },
      { fact_id: Number(blank.id), reason: 'fence_unrenderable', class: 'empty' }] }] });
    expect(check.message).toContain('2 legacy fact row(s) on 1 page(s) cannot be adopted into their facts fence: people/alice-example');
    expect(check.message).toContain('empty, struck');
    expect(check.message).toContain('stay active and searchable and nothing is lost');
    expect(check.message).not.toContain('forget_fact');
    const rendered = renderAction(check.fix!, cliRenderContext());
    expect(rendered.next).toBe('report');
    expect(rendered.command).toBeUndefined();
    expect(rendered.verify).toEqual({ argv: ['gbrain', 'doctor', '--only', 'fence_integrity', '--json'] });
    expect(rendered.docs).toContain('write-refusals.md#fence_unrenderable');
    const text = JSON.stringify(check);
    for (const leak of ['Sentinelstruckzq6', 'Sentineltrailingzq6', 'left the board', 'keeps bees', ...SECRETS]) expect(text).not.toContain(leak);
    // Nothing was written: the rows are exactly as inserted.
    const rows = await engine.executeRaw<{ id: number; fact: string; row_num: number | null; expired: boolean }>(
      'SELECT id, fact, row_num, expired_at IS NOT NULL AS expired FROM facts WHERE id = ANY($1::integer[]) ORDER BY id', [[struck.id, blank.id, trailing.id]]);
    expect(rows.map(r => [r.fact, r.row_num, r.expired])).toEqual([[STRUCK, null, false], ['   ', null, false], [TRAILING, null, false]]);
    await engine.executeRaw('DELETE FROM facts WHERE source_id = $1', [s.id]);
    expect((await result()).status).toBe('ok');
  });

  test('a census the scan did not finish is partial and never ok, even with nothing found so far', async () => {
    const s = await source({ 'notes/clean.md': md('Clean', CLEAN) });
    await stored(s.id, 'notes/clean', CLEAN);
    const partial = await result({ timeoutMs: 0 });
    expect(partial.status).toBe('warn');
    expect(partial.details).toMatchObject({ total: 0, partial: true });
    expect((partial.details as any).partial_sources).toContain(s.id);
    expect(partial.message).toContain('PARTIAL CENSUS');
    expect(partial.fix!.argv).toEqual(['gbrain', 'doctor', '--only', 'fence_integrity', '--json']);
    expect((await result()).status).toBe('ok');
    // A finished census goes stale when a later scan cannot catch up: still never ok.
    await stored(s.id, 'notes/later', CLEAN);
    expect((await result({ timeoutMs: 0 })).details).toMatchObject({ partial: true });
  });

  test('the 7-day normalization trend warns at the threshold and not below, naming the top writers', async () => {
    const s = await source();
    for (let i = 0; i < FENCE_NORMALIZATION_WARN_7D - 1; i++) {
      await recordWriteTrend(engine, { sourceId: s.id, requestKey: `r-${i}`, day: i % 2 ? '2026-10-06' : '2026-10-01', byClass: { renumber: 1 }, writer: i % 3 ? 'oauth_client' : 'local_cli' });
    }
    // Older than the 7-day window: never counted.
    await recordWriteTrend(engine, { sourceId: s.id, requestKey: 'old', day: '2026-09-29', byClass: { renumber: 1 }, writer: 'local_cli' });
    const below = await result();
    expect(below.status).toBe('ok');
    expect((below.details as any).trend.find((t: any) => t.source_id === s.id).normalized_7d).toBe(FENCE_NORMALIZATION_WARN_7D - 1);
    await recordWriteTrend(engine, { sourceId: s.id, requestKey: 'last', day: '2026-10-06', byClass: { close_fence: 1 }, writer: 'oauth_client' });
    const at = await result();
    expect(at.status).toBe('warn');
    expect(at.message).toContain(`${s.id} had ${FENCE_NORMALIZATION_WARN_7D} normalized in 7 days (top writers: oauth_client 13, local_cli 7)`);
    expect((at.details as any).trend.find((t: any) => t.source_id === s.id)).toMatchObject({ normalized_7d: FENCE_NORMALIZATION_WARN_7D,
      top_writers: [{ writer: 'oauth_client', count: 13 }, { writer: 'local_cli', count: 7 }] });
  });

  test('shows the model-repair caps and today\'s ledger spend, and says when model spend is off', async () => {
    const s = await source();
    await stored(s.id, 'notes/model', LLM);
    const ledger = dailyLedger(engine, FENCE_REPAIR_LEDGER, { now: () => NOW });
    const held = await ledger.reserve(0.2, { capUsd: 1 });
    if (!held.ok) throw new Error('expected a reservation');
    await ledger.dispatch(held.reservation.id);
    await ledger.settle(held.reservation.id, 0.12);
    await engine.setConfig('fences.repair.max_usd_per_page', '0.1');
    const capped = await result();
    expect(capped.details).toMatchObject({ model_repair: { max_usd_per_page: 0.1, max_usd_per_day: 1, spent_today_usd: 0.12, reserved_today_usd: 0 } });
    expect(capped.message).toContain('Model repair caps: $0.10 per page, $1.00 per day ($0.12 spent today).');
    await engine.setConfig('fences.repair.max_usd_per_day', '0');
    expect((await result()).message).toContain('Model repair spend is off (fences.repair.max_usd_per_day 0).');
  });
});
