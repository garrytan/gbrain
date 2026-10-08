/**
 * #6188 PR4: `gbrain repair fences`, end to end on managed, legacy,
 * database-only and mirror sources, with the model behind the gateway's chat
 * transport seam.
 *
 * Protects: the preview lists every tier with its estimated model cost and
 * makes no model call; the printed apply command runs as printed and repairs
 * each tier (managed: file rewritten, imported, hold cleared, Git commit
 * whose subject names the path and classes, a fence-repair receipt; legacy:
 * backup, import and an uncommitted-repair notice that clears once the path
 * is committed; database-only: a revision-bound page write; mirror: the page
 * is repaired and the file never written); every gate failure keeps the hold
 * with its gate; the attempt memo makes the second run on an unchanged
 * rejected file spend nothing, while a transient provider error does not
 * consume it; an agent journey where every model proposal is rejected never
 * reports anything repaired; budget exhausted (run stop, exit 1, the D15
 * message and paid fix), model repair disabled, unpriced model under a user
 * cap; changed_since_preview, sync_in_progress and owner_unavailable write
 * nothing; a remote caller cannot reach Tier 3; --max-usd only lowers the cap
 * and only paid-model kinds accept it; Tier 2 accepts only a strict
 * people/companies match and never a private page on a world page; the
 * location-only privacy rule on holds, receipts, results and commits.
 * Fails when: any of those paths regresses (a write without the gates, a
 * second paid call for the same bytes, a hidden spend, a remote write, an
 * unrunnable printed command).
 * Why new: the fences kind is new in PR4.
 * Seams: __setChatTransportForTests (no provider call); test/postgres-unit-arms.txt runs the Postgres arm.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError, type OperationContext } from '../src/core/ops/contract.ts';
import { __setChatTransportForTests, configureGateway, resetGateway, type ChatOpts, type ChatResult } from '../src/core/ai/gateway.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { parseTakesFence } from '../src/core/takes-fence.ts';
import { resolveRepairScope, type RepairResult } from '../src/core/repair/core.ts';
import { repairRunner, repairSpec } from '../src/core/repair/registry.ts';
import { planRepairSteps, runRepairSteps } from '../src/core/remediation/repairs.ts';
import { runFenceRepairPhase } from '../src/core/cycle/fence-repair.ts';
import { fenceIntegrityResult } from '../src/commands/doctor/checks/fence-integrity.ts';
import { fencesRepair, type FencesPreviewDetails } from '../src/core/repair/fences.ts';
import { readUncommittedFenceRepairs } from '../src/core/fence-repair/uncommitted.ts';
import { fenceHoldStatus } from '../src/core/fence-repair/hold-fix.ts';
import { parseRepairArgs, runRepairCommand } from '../src/commands/repair.ts';
import { runModels } from '../src/commands/models.ts';
import { resolveFenceRepairModel } from '../src/core/fence-repair/model.ts';
import { FENCE_REPAIR_MEASURED_MODELS } from '../src/core/fence-repair/measured.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-fences-'));
const engines: BrainEngine[] = [];
let legacyEngine: PGLiteEngine;
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: 'sk-test-not-used', GBRAIN_FENCE_REPAIR_SCAN_MS: '60000' };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message = 'content') => { git(root, 'add', '-A'); git(root, 'commit', '-qm', message); return git(root, 'rev-parse', 'HEAD'); };
const quiet = { info() {}, warn() {}, error() {} };

// Unique strings that must never leave a file through a hold, receipt, result field or commit message.
const CLAIM = 'Sentinelclaimzr4 ships quarterly', HOLDER = 'Alice Example', MCLAIM = 'Sentinelmanualzr4 opens an office';
const FB = '<!--- gbrain:facts:begin -->', FBE = '<!--- gbrain:facts:end -->';
const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|';
const NARROW = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |';
const SEP = '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|';
const T = '<!--- gbrain:takes:begin -->', TE = '<!--- gbrain:takes:end -->';
const TH = '| # | claim | kind | who | weight | since | source |\n|---|---|---|---|---|---|---|';
const row = (claim: string) => `| 1 | ${claim} | fact | 0.9 | private | high | 2026-01-01 |  | chat | ctx |`;
const md = (title: string, body: string, extra = '') => `---\ntitle: ${title}\n${extra}---\nA synthetic page.\n\n${body}`;
/** Tier 3: rows but no header. */
const noHeader = (claim = CLAIM) => `${FB}\n${row(claim)}\n${FBE}\n`;
/** Tier 1: a missing end marker and an invented kind. */
const fixable = (claim = 'Synthetic vendor partnership') => `${FB}\n${FH}\n| 1 | ${claim} | partnership | 0.9 | private | high | 2026-01-01 |  | chat |  |\n`;
/** Tier 2: a display-name holder. */
const holder = (who = HOLDER) => `${T}\n${TH}\n| 1 | Synthetic take | take | ${who} | 0.7 | 2026-01 | chat |\n${TE}\n`;
/** Manual: a visibility word with no mapping. */
const manual = (claim = MCLAIM) => `${FB}\n${FH}\n| 1 | ${claim} | fact | 0.9 | sideways | high | 2026-01-01 |  | chat | ctx |\n${FBE}\n`;
const answer = (claim: string, text = `${NARROW}\n${SEP}\n${row(claim)}`, stop: ChatResult['stopReason'] = 'end'): ChatResult => ({ text, blocks: [], stopReason: stop,
  usage: { input_tokens: 500, output_tokens: 120, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-opus-4-7', providerId: 'anthropic' });

let calls: ChatOpts[] = [];
function transport(reply: (opts: ChatOpts, n: number) => ChatResult | Error) {
  calls = [];
  __setChatTransportForTests(async opts => { calls.push(opts); const out = reply(opts, calls.length); if (out instanceof Error) throw out; return out; });
}

beforeAll(async () => {
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
  legacyEngine = new PGLiteEngine(); await legacyEngine.connect({}); await legacyEngine.initSchema();
}, 120_000);

beforeEach(() => { _resetCliExitVerdictForTests(); });
afterEach(() => { __setChatTransportForTests(null); _resetCliExitVerdictForTests(); });

afterAll(async () => {
  await withEnv(env, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await legacyEngine.disconnect();
  await closePostgres?.(); resetGateway(); rmSync(home, { recursive: true, force: true });
});

function newRoot(prefix: string, files: Record<string, string>) {
  const id = `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 16)}`, root = join(home, id);
  mkdirSync(root, { recursive: true }); git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
  const write = (path: string, content: string) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); };
  for (const [path, content] of Object.entries(files)) write(path, content);
  commit(root, 'fixture');
  return { id, root, write, read: (path: string) => readFileSync(join(root, path), 'utf8') };
}

async function managed(engine: BrainEngine, files: Record<string, string>, opts: { mirror?: boolean } = {}) {
  const r = newRoot('fen', files);
  writeFileSync(join(r.root, '.git', 'hooks', 'post-commit'), '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\n'); chmodSync(join(r.root, '.git', 'hooks', 'post-commit'), 0o755);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw(`INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)`, [r.id, r.root, JSON.stringify(opts.mirror ? { mirror_read_only: true } : {})]);
  await claimWorktree(engine, r.id, r.root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { ...r, ...helpers(engine, r.id) };
}

function helpers(engine: BrainEngine, id: string) {
  const sync = () => performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true });
  const holds = async () => (await readGitSourceHolds(engine, { sourceIds: [id] }))[0]?.holds ?? [];
  const run = async (opts: { apply?: boolean; expect?: string; only?: string[]; slugs?: string[]; noLlm?: boolean; maxLlmUsd?: number } = {}) => {
    const runner = await repairRunner(engine, { apply: opts.apply === true, noEmbed: true, logger: quiet });
    return runner.run('fences', await resolveRepairScope(engine, id), { explicit: true, sourceFlag: id, expect: opts.expect, only: opts.only, slugs: opts.slugs,
      noLlm: opts.noLlm, maxLlmUsd: opts.maxLlmUsd });
  };
  return { sync, holds, run };
}

/** Prints of `gbrain repair` with these args. */
async function cli(engine: BrainEngine, args: string[]): Promise<string> {
  const out: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => { out.push(parts.join(' ')); };
  try { await runRepairCommand(engine, args); } finally { console.log = log; }
  return out.join('\n');
}

async function gitEffectsSettled(engine: BrainEngine, sourceId: string) {
  for (let i = 0; i < 100; i++) {
    await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 10 });
    const open = await engine.executeRaw("SELECT 1 FROM persistence_effects WHERE source_id=$1 AND kind='git' AND state<>'committed'", [sourceId]);
    if (!open.length) return;
    await Bun.sleep(100);
  }
  throw new Error('git effects did not settle');
}

const incarnationOf = async (engine: BrainEngine, id: string) => (await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [id]))[0]!.incarnation;
const details = (result: RepairResult) => result.details as unknown as FencesPreviewDetails;
const hashOf = (result: RepairResult) => result.apply_command.split('--expect ')[1]!.split(' ')[0]!;
const expectNoSecrets = (value: unknown) => { const text = typeof value === 'string' ? value : JSON.stringify(value); for (const secret of [CLAIM, MCLAIM, 'Sentinelclaimzr4', 'Sentinelmanualzr4']) expect(text).not.toContain(secret); };
/** Result fields that carry no diff: the preview's diffs show file lines to the operator by design (D14). */
const surfaceOf = (result: RepairResult) => ({ ...result, details: undefined });

async function each(run: (engine: BrainEngine) => Promise<void>) {
  await withEnv(env, async () => {
    configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6' } as never);
    for (const engine of engines) {
      try { await run(engine); } finally { await disposePersistenceConsumer(engine); }
    }
  });
}

test('preview lists every tier with its cost and calls no model; the printed apply command repairs each tier and leaves the manual one held', () => each(async engine => {
  const s = await managed(engine, { 'people/alice-example.md': md('Alice Example', 'A synthetic person.\n'), 'notes/a.md': md('A', 'Plain.\n'),
    'people/model.md': md('Model', noHeader()), 'people/holder.md': md('Holder', holder()), 'people/manual.md': md('Manual', manual()) });
  expect((await s.sync()).held_count).toBe(3);
  s.write('people/later.md', md('Later', fixable()));
  transport(() => answer(CLAIM));
  const preview = JSON.parse(await cli(engine, ['fences', '--source', s.id, '--json'])) as { results: RepairResult[] };
  const result = preview.results[0]!;
  expect(calls).toHaveLength(0);
  expect(result.listing!.map(entry => [entry.item, entry.class]).sort()).toEqual([
    [`${s.id}:people/holder.md`, 'resolver'], [`${s.id}:people/later.md`, 'deterministic'], [`${s.id}:people/manual.md`, 'enum_unmapped'], [`${s.id}:people/model.md`, 'llm']]);
  expect(details(result).counts).toEqual({ deterministic: 1, resolver: 1, llm: 1, held: 1 });
  expect(result.cost.llm_usd).toBeGreaterThan(0);
  expect(result.cost.llm_cap_remaining_usd).toBe(1);
  expect(details(result).samples.deterministic!.diff).toContain(`+${FBE}`);
  expect(details(result).samples.resolver!.diff).toContain('people/alice-example');
  expect(details(result).held[0]!.resolution).toContain('visibility');
  expect(result.apply_command).toBe(`gbrain repair fences --source ${s.id} --apply --expect ${hashOf(result)}`);
  expect(s.read('people/model.md')).toBe(md('Model', noHeader()));
  // The printed command runs exactly as printed.
  const applied = (JSON.parse(await cli(engine, [...result.apply_command.split(' ').slice(2), '--json'])) as { results: RepairResult[] }).results[0]!;
  expect(applied).toMatchObject({ mode: 'apply', applied: 3, repaired: 3, remaining: { enum_unmapped: 1 }, outcomes: { repaired: 3 } });
  expect(calls).toHaveLength(1);
  const prompt = `${calls[0]!.system}\n${JSON.stringify(calls[0]!.messages)}`;
  expect(prompt).toContain(CLAIM);
  expect(prompt).not.toContain(MCLAIM);
  expect(prompt).not.toContain('A synthetic page.');
  expect(parseFactsFence(s.read('people/model.md')).warnings).toEqual([]);
  expect(parseFactsFence(s.read('people/later.md')).warnings).toEqual([]);
  expect(parseTakesFence(s.read('people/holder.md')).takes[0]!.holder).toBe('people/alice-example');
  expect((await engine.getPage('people/model', { sourceId: s.id }))?.compiled_truth).toContain(CLAIM);
  // Only the manual file is still held, with the reason the repair left on it.
  const holds = await s.holds();
  expect(holds.map(h => h.path)).toEqual(['people/manual.md']);
  expect(holds[0]!.meta.fence?.reason).toBe('enum_unmapped');
  // A bare apply (the maintenance run) records on the hold why it stays.
  expect(await s.run({ apply: true })).toMatchObject({ applied: 0, remaining: { enum_unmapped: 1 } });
  expect((await s.holds())[0]!.meta.fence_repair).toMatchObject({ reason: 'enum_unmapped', tier: 'manual', next_attempt_after: null });
  // Commits name the path and the classes; receipts carry the fence-repair actor, tier, model, hashes and cost; nothing carries a cell value.
  await gitEffectsSettled(engine, s.id);
  // One commit per file reads `gbrain: repair fence in <path> (<classes>)`; a batched commit lists `<path> (<classes>)` per body line.
  const log = git(s.root, 'log', '--format=%B');
  expect(log).toContain('people/model.md (no_header)');
  expect(log).toContain('people/holder.md (holder_verified)');
  expect(git(s.root, 'status', '--porcelain', '--', 'people/model.md')).toBe('');
  const receipts = await engine.executeRaw<{ outcome: Record<string, any> }>("SELECT outcome FROM persistence_requests WHERE source_id=$1 AND outcome ? 'fence_repair' ORDER BY sequence", [s.id]);
  expect(receipts.map(r => r.outcome.fence_repair.tier).sort()).toEqual(['deterministic', 'llm', 'resolver']);
  const llmReceipt = receipts.find(r => r.outcome.fence_repair.tier === 'llm')!.outcome.fence_repair;
  expect(llmReceipt).toMatchObject({ actor: 'fence-repair', classes: ['no_header'], model: 'anthropic:claude-opus-5-5' });
  expect(llmReceipt.cost_usd).toBeGreaterThan(0);
  expectNoSecrets([holds, receipts.map(r => r.outcome.fence_repair), surfaceOf(applied), git(s.root, 'log', '--format=%B')]);
}), 240_000);

test('every model proposal rejected: the hold keeps its gate, nothing is reported repaired, and a second run on the same bytes spends nothing', () => each(async engine => {
  const s = await managed(engine, { 'people/model.md': md('Model', noHeader()) });
  await s.sync();
  transport(() => answer('A different claim'));
  const first = await s.run({ apply: true });
  expect(first).toMatchObject({ applied: 0, repaired: 0, remaining: { claim_changed: 1 }, outcomes: { held: 1 } });
  // Gate (b) is not structural, so there is no corrective re-ask.
  expect(calls).toHaveLength(1);
  expect((await s.holds())[0]!.meta.fence_repair).toMatchObject({ reason: 'claim_changed', gate: 'b' });
  expect(first.cost.llm_usd).toBeGreaterThan(0);
  const human = await cli(engine, ['fences', '--source', s.id, '--apply']);
  expect(human).toContain('repaired 0; still waiting: claim_changed=1');
  expect(human).not.toContain('repaired 1');
  // The memo: the same bytes, model, rules and prompt are never sent again.
  const again = await s.run({ apply: true });
  expect(calls).toHaveLength(1);
  expect(again).toMatchObject({ applied: 0, repaired: 0, remaining: { claim_changed: 1 } });
  expect(again.cost.llm_usd).toBe(0);
  const preview = await s.run();
  expect(details(preview).held[0]).toMatchObject({ reason: 'claim_changed', gate: 'b' });
  expect(s.read('people/model.md')).toBe(md('Model', noHeader()));
  // New bytes are a new memo key: the next run asks again.
  s.write('people/model.md', md('Model', noHeader(), 'tags: [synthetic]\n')); commit(s.root, 'edit');
  await s.sync();
  transport(() => answer(CLAIM));
  expect(await s.run({ apply: true })).toMatchObject({ repaired: 1 });
  expect(calls).toHaveLength(1);
  expectNoSecrets([await s.holds(), surfaceOf(first), surfaceOf(again)]);
}), 240_000);

test('a transient provider error keeps the memo; model repair off and --no-llm hold without a call; a user cap with an unpriced model holds no_pricing', () => each(async engine => {
  const s = await managed(engine, { 'people/model.md': md('Model', noHeader()) });
  await s.sync();
  transport(() => Object.assign(new Error('rate limited'), { status: 429 }));
  expect(await s.run({ apply: true })).toMatchObject({ repaired: 0, remaining: { llm_unavailable: 1 } });
  expect((await s.holds())[0]!.meta.fence_repair).toMatchObject({ reason: 'llm_unavailable', tier: 'llm' });
  transport(() => answer(CLAIM));
  expect(await s.run({ apply: true, noLlm: true })).toMatchObject({ repaired: 0, remaining: { llm_disabled: 1 } });
  await engine.setConfig('fences.repair.llm', 'false');
  expect(await s.run({ apply: true })).toMatchObject({ repaired: 0, remaining: { llm_disabled: 1 } });
  expect(calls).toHaveLength(0);
  await engine.setConfig('fences.repair.llm', 'true');
  await engine.setConfig('models.fence_repair', 'anthropic:claude-unpriced-zr4');
  await engine.setConfig('fences.repair.max_usd_per_page', '0.05');
  const refused = await s.run();
  expect(details(refused).held[0]).toMatchObject({ reason: 'no_pricing' });
  expect(details(refused).held[0]!.resolution).toContain('gbrain pricing set');
  expect(calls).toHaveLength(0);
  // Under the default caps an unpriced model warns and runs, metered at the ceiling rate.
  await engine.executeRaw("DELETE FROM config WHERE key='fences.repair.max_usd_per_page'");
  const warned = await s.run();
  expect(warned.warnings?.join(' ')).toContain('gbrain pricing set anthropic:claude-unpriced-zr4');
  expect(warned.cost.llm_usd).toBeGreaterThan(0);
  const ran = await s.run({ apply: true });
  expect(ran).toMatchObject({ repaired: 1 });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.model).toBe('anthropic:claude-unpriced-zr4');
  await engine.executeRaw("DELETE FROM config WHERE key IN ('models.fence_repair','fences.repair.llm')");
}), 240_000);

test('the daily ledger refusing the next call stops the run with the reset time, the waiting pages and the paid fix (exit 1)', () => each(async engine => {
  const s = await managed(engine, { 'people/model.md': md('Model', noHeader()) });
  await s.sync();
  transport(() => answer(CLAIM));
  await engine.setConfig('fences.repair.max_usd_per_day', '0.001');
  const out = JSON.parse(await cli(engine, ['fences', '--source', s.id, '--apply', '--json'])) as { results: RepairResult[] };
  const result = out.results[0]!;
  expect(currentExitCode()).toBe(1);
  expect(calls).toHaveLength(0);
  expect(result.stopped).toMatchObject({ reason: 'budget_exhausted', fix: { argv: ['gbrain', 'config', 'set', 'fences.repair.max_usd_per_day', '<usd>'], consent: ['paid'], actor: 'agent' } });
  expect(result.stopped!.message).toMatch(/resets at \d{4}-\d{2}-\d{2}T00:00:00\.000Z/);
  expect(result.stopped!.message).toContain('1 page(s) wait');
  expect((await s.holds())[0]!.meta.fence_repair).toMatchObject({ reason: 'budget_exhausted' });
  expect((await s.holds())[0]!.meta.fence_repair!.next_attempt_after).toMatch(/T00:00:00\.000Z$/);
  await engine.executeRaw("DELETE FROM config WHERE key='fences.repair.max_usd_per_day'");
}), 240_000);

test('a file changed since the preview, an unfinished sync whose manifest cannot be read, and a non-owner host write nothing', () => each(async engine => {
  const s = await managed(engine, { 'people/model.md': md('Model', noHeader()) });
  await s.sync();
  transport(() => answer(CLAIM));
  const preview = await s.run();
  const edited = md('Model', noHeader(), 'tags: [edited]\n');
  s.write('people/model.md', edited);
  expect(await s.run({ apply: true, expect: hashOf(preview) })).toMatchObject({ applied: 0, outcomes: { skipped: 1 }, remaining: { changed_since_preview: 1 } });
  expect(s.read('people/model.md')).toBe(edited);
  expect(calls).toHaveLength(0);
  s.write('people/model.md', md('Model', noHeader()));
  // An unfinished cursor of this incarnation whose manifest is missing: the busy set fails closed, so every candidate waits.
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync',$1,$2::text::jsonb)`,
    [`probe-${s.id}`, JSON.stringify([{ sourceId: s.id, incarnation: await incarnationOf(engine, s.id), runId: 'probe', index: 0, done: false }])]);
  expect((await s.run()).listing!.find(entry => entry.class === 'sync_in_progress')!.detail).toContain('the manifest of sync run probe is missing');
  const busy = await s.run({ apply: true });
  expect(busy).toMatchObject({ applied: 0, remaining: { sync_in_progress: 1 } });
  expect((await s.holds())[0]!.meta.fence_repair).toMatchObject({ reason: 'sync_in_progress' });
  await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1", [`probe-${s.id}`]);
  const approved = await s.run();
  expect(approved.affected).toBe(1);
  const stranger = randomUUID();
  const worktree = async (sql: string, params: unknown[]) => engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
    await tx.executeRaw(sql, [...params, s.id]);
  });
  await worktree('UPDATE persistence_worktrees SET owner_host_id=$1::uuid WHERE id=(SELECT worktree_id FROM persistence_source_bindings WHERE source_id=$2 LIMIT 1)', [stranger]);
  // An approved set applied after the owner changed: the item is skipped with the reason, the read-only fix and retryable false.
  const skip = (await s.run({ apply: true, expect: hashOf(approved) })).outcome_items![0]!;
  expect(skip).toMatchObject({ outcome: 'skipped', reason: 'host_mismatch', detail: { retryable: false, fix: ['gbrain', 'sources', 'writer', 'status', '--source', s.id, '--json'] } });
  expect(skip.detail!.message).toContain(stranger.slice(0, 8));
  expect(skip.detail!.message).toContain(localHostId().slice(0, 8));
  expect(skip.detail!.why).toContain(join(home, '.gbrain', 'persistence', 'host.json'));
  const elsewhere = await s.run({ apply: true });
  expect(elsewhere).toMatchObject({ applied: 0, remaining: { host_mismatch: 1 } });
  expect((await s.holds())[0]!.meta.fence_repair).toMatchObject({ reason: 'host_mismatch' });
  expect(fenceHoldStatus((await s.holds())[0]!.meta).state).toBe('owner');
  const local = (await s.run()).listing!.find(entry => entry.class === 'host_mismatch')!;
  expect(local.detail).toContain(stranger.slice(0, 8));
  expect(local.detail).toContain(join(home, '.gbrain', 'persistence', 'host.json'));
  // A plan for a remote caller gets both ids but never the identity path.
  const remote = (await fencesRepair.plan(engine, await resolveRepairScope(engine, s.id), null, { apply: false, remote: true })).listing!.find(entry => entry.class === 'host_mismatch')!;
  expect(remote.detail).toContain(stranger.slice(0, 8));
  expect(remote.detail).toContain(localHostId().slice(0, 8));
  expect(remote.detail).not.toContain('host.json');
  await worktree('UPDATE persistence_worktrees SET owner_host_id=$1::uuid, state=$2 WHERE id=(SELECT worktree_id FROM persistence_source_bindings WHERE source_id=$3 LIMIT 1)', [localHostId(), 'draining']);
  expect(await s.run({ apply: true })).toMatchObject({ applied: 0, remaining: { transfer_in_progress: 1 } });
  await worktree('UPDATE persistence_worktrees SET state=$1 WHERE id=(SELECT worktree_id FROM persistence_source_bindings WHERE source_id=$2 LIMIT 1)', ['recovering']);
  expect(await s.run({ apply: true })).toMatchObject({ applied: 0, remaining: { clone_in_progress: 1 } });
  expect((await s.holds())[0]!.meta.fence_repair).toMatchObject({ reason: 'clone_in_progress' });
  await worktree('UPDATE persistence_worktrees SET state=$1 WHERE id=(SELECT worktree_id FROM persistence_source_bindings WHERE source_id=$2 LIMIT 1)', ['active']);
  expect(calls).toHaveLength(0);
  expect(s.read('people/model.md')).toBe(md('Model', noHeader()));
}), 240_000);

test('a running sync no longer skips the source: only candidates in flight or ahead in its frozen manifest wait, and a held path is not busy', () => each(async engine => {
  const s = await managed(engine, { 'people/held.md': md('Held', noHeader()), 'notes/plain.md': md('Plain', 'Nothing here.\n') });
  expect((await s.sync()).held_count).toBe(1);
  s.write('people/ahead.md', md('Ahead', fixable('Synthetic ahead partnership')));
  s.write('people/later.md', md('Later', fixable('Synthetic later partnership')));
  s.write('people/moved.md', md('Moved', fixable('Synthetic moved partnership')));
  commit(s.root, 'more fences');
  const incarnation = await incarnationOf(engine, s.id);
  const entry = (path: string, extra: Record<string, unknown> = {}) => ({ path, sourcePath: path, action: 'import', working: false, slug: path.replace(/\.md$/, ''), ...extra });
  // A frozen catch-up that has passed entry 0 and still has three entries ahead, one of them the held path (its bytes changed since the hold).
  const manifest = [entry('notes/plain.md'), entry('people/ahead.md'), entry('people/held.md'), entry('people/moved.md', { renameFrom: { sourcePath: 'people/later.md', slug: 'people/later', pageId: 1, revision: 'r' } })];
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync-manifest','run-ahead',$1::text::jsonb)`, [JSON.stringify(manifest)]);
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync',$1,$2::text::jsonb)`,
    [`ahead-${s.id}`, JSON.stringify([{ sourceId: s.id, incarnation, runId: 'run-ahead', index: 1, done: false }])]);
  transport(() => answer(CLAIM));
  const preview = await s.run();
  const byItem = Object.fromEntries(preview.listing!.map(entry => [entry.item.slice(s.id.length + 1), entry.class]));
  expect(byItem).toEqual({ 'people/held.md': 'llm', 'people/ahead.md': 'sync_in_progress', 'people/later.md': 'sync_in_progress', 'people/moved.md': 'sync_in_progress' });
  expect(preview.listing!.find(entry => entry.class === 'sync_in_progress')!.detail).toContain('A running sync of');
  const applied = await s.run({ apply: true });
  expect(applied).toMatchObject({ repaired: 1, remaining: { sync_in_progress: 3 } });
  expect(calls).toHaveLength(1);
  expect((await s.holds()).map(h => h.path)).toEqual([]);
  expect(s.read('people/held.md')).toContain(FBE);
  expect(s.read('people/ahead.md')).toBe(md('Ahead', fixable('Synthetic ahead partnership')));
  // The cursor passes the three entries: the next run repairs them with no model call (Tier 1).
  await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=$2::text::jsonb WHERE op='managed-sync' AND fingerprint=$1`,
    [`ahead-${s.id}`, JSON.stringify([{ sourceId: s.id, incarnation, runId: 'run-ahead', index: 4, done: false }])]);
  expect(await s.run({ apply: true })).toMatchObject({ repaired: 3 });
  expect(calls).toHaveLength(1);
  await engine.executeRaw("DELETE FROM op_checkpoints WHERE (op='managed-sync' AND fingerprint=$1) OR (op='managed-sync-manifest' AND fingerprint='run-ahead')", [`ahead-${s.id}`]);
}), 240_000);

test('a sync that freezes the candidate while the model answers is caught at the write\'s admission: nothing is written, and the attempt is not spent', () => each(async engine => {
  const s = await managed(engine, { 'notes/plain.md': md('Plain', 'Nothing here.\n') });
  await s.sync();
  s.write('people/model.md', md('Model', noHeader()));
  commit(s.root, 'a model fence');
  const incarnation = await incarnationOf(engine, s.id);
  const freeze = async () => {
    await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync-manifest','run-wait',$1::text::jsonb)`,
      [JSON.stringify([{ path: 'people/model.md', sourcePath: 'people/model.md', action: 'import', working: false, slug: 'people/model' }])]);
    await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync',$1,$2::text::jsonb)`,
      [`wait-${s.id}`, JSON.stringify([{ sourceId: s.id, incarnation, runId: 'run-wait', index: 0, done: false }])]);
  };
  let n = 0;
  __setChatTransportForTests(async () => { n++; if (n === 1) await freeze(); return answer(CLAIM); });
  const raced = await s.run({ apply: true });
  expect(raced).toMatchObject({ applied: 0, remaining: { sync_in_progress: 1 } });
  expect(raced.outcome_items![0]).toMatchObject({ outcome: 'skipped', reason: 'sync_in_progress' });
  expect(raced.outcome_items![0]!.detail!.message).toContain('started after this repair was planned');
  expect(n).toBe(1);
  expect(s.read('people/model.md')).toBe(md('Model', noHeader()));
  await engine.executeRaw("DELETE FROM op_checkpoints WHERE (op='managed-sync' AND fingerprint=$1) OR (op='managed-sync-manifest' AND fingerprint='run-wait')", [`wait-${s.id}`]);
  // The attempt memo recorded a transient outcome, so the same bytes are sent again once the sync is gone.
  expect(await s.run({ apply: true })).toMatchObject({ repaired: 1 });
  expect(n).toBe(2);
  expect(s.read('people/model.md')).toContain(NARROW);
}), 240_000);

test('a read-only mirror is repaired in the database only and its hold cleared; the file is never written', () => each(async engine => {
  const s = await managed(engine, { 'people/model.md': md('Model', noHeader()) }, { mirror: true });
  await s.sync();
  expect((await s.holds()).map(h => h.path)).toEqual(['people/model.md']);
  transport(() => answer(CLAIM));
  const applied = await s.run({ apply: true });
  expect(applied).toMatchObject({ repaired: 1 });
  expect(applied.outcome_items![0]!.detail).toMatchObject({ mode: 'mirror', storage: 'database_only' });
  expect(s.read('people/model.md')).toBe(md('Model', noHeader()));
  expect(parseFactsFence((await engine.getPage('people/model', { sourceId: s.id }))!.compiled_truth).facts.map(f => f.claim)).toEqual([CLAIM]);
  expect(await s.holds()).toEqual([]);
}), 240_000);

test('a remote caller can never reach Tier 3 or a write', () => each(async engine => {
  const s = await managed(engine, { 'people/model.md': md('Model', noHeader()) });
  await s.sync();
  transport(() => answer(CLAIM));
  const plan = await fencesRepair.plan(engine, await resolveRepairScope(engine, s.id), null, { apply: true });
  const ctx = { engine, config: { engine: engine.kind }, logger: quiet, dryRun: false, remote: true, sourceId: s.id } as unknown as OperationContext;
  let error: unknown;
  try { await fencesRepair.apply(ctx, plan.items[0]!, { embed: false }); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(OperationError);
  expect((error as OperationError).code).toBe('permission_denied');
  expect(calls).toHaveLength(0);
  expect(s.read('people/model.md')).toBe(md('Model', noHeader()));
}), 240_000);

test('--max-usd lowers the cap only, is printed in the apply command, and only paid-model kinds accept it', () => each(async engine => {
  const s = await managed(engine, { 'people/model.md': md('Model', noHeader()) });
  await s.sync();
  transport(() => answer(CLAIM));
  expect(() => parseRepairArgs(['timeline', '--max-usd', '1'])).toThrow(/applies only to a kind that may call a paid model/);
  expect(() => parseRepairArgs(['timeline', '--max-usd', '1'])).toThrow(OperationError);
  expect(() => parseRepairArgs(['fences', '--max-usd', 'lots'])).toThrow(/non-negative USD amount/);
  const dayLeft = (await s.run()).cost.llm_cap_remaining_usd!;
  expect(dayLeft).toBeGreaterThan(0.25);
  const high = await s.run({ maxLlmUsd: 5 });
  expect(high.cost.llm_cap_remaining_usd).toBe(dayLeft);
  const low = await s.run({ maxLlmUsd: 0.25 });
  expect(low.cost.llm_cap_remaining_usd).toBe(0.25);
  expect(low.apply_command).toContain('--max-usd 0.25 --apply --expect ');
  const none = await s.run({ apply: true, maxLlmUsd: 0 });
  expect(none.stopped).toMatchObject({ reason: 'budget_exhausted' });
  expect(calls).toHaveLength(0);
  expect(s.read('people/model.md')).toBe(md('Model', noHeader()));
}), 240_000);

test('Tier 2 takes only a strict people/companies match and never a private page on a world page', () => each(async engine => {
  const s = await managed(engine, { 'people/alice-example.md': md('Alice Example', 'Private person.\n', 'visibility: private\n'),
    'people/world.md': md('World', holder(), 'visibility: world\n'), 'people/bare.md': md('Bare', holder('Alice')) });
  await s.sync();
  const preview = await s.run();
  const held = Object.fromEntries(details(preview).held.map(h => [h.item.split(':')[1], h.reason]));
  expect(held).toEqual({ 'people/world.md': 'holder_unresolved', 'people/bare.md': 'holder_unresolved' });
  expect(preview.affected).toBe(0);
}), 240_000);

test('legacy sources: backup, import and an uncommitted-repair notice that clears once the path is committed; a symlink is never written', async () => withEnv(env, async () => {
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6' } as never);
  const engine = legacyEngine;
  const r = newRoot('leg', { 'notes/model.md': md('Model', noHeader()), 'notes/later.md': md('Later', fixable()) });
  writeFileSync(join(home, `${r.id}-target.md`), md('Target', noHeader('Linked claim')));
  symlinkSync(join(home, `${r.id}-target.md`), join(r.root, 'notes/linked.md'));
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [r.id, r.root]);
  const h = helpers(engine, r.id);
  transport(() => answer(CLAIM));
  const preview = await h.run();
  expect(preview.listing!.map(entry => [entry.item, entry.class]).sort()).toEqual([[`${r.id}:notes/later.md`, 'deterministic'], [`${r.id}:notes/model.md`, 'llm']]);
  const applied = await h.run({ apply: true, expect: hashOf(preview) });
  expect(applied).toMatchObject({ repaired: 2 });
  const detail = applied.outcome_items!.find(o => o.item.endsWith('notes/model'))!.detail!;
  expect(detail).toMatchObject({ mode: 'legacy', committed: 'commit_step' });
  expect(existsSync(String(detail.backup))).toBe(true);
  expect(readFileSync(String(detail.backup), 'utf8')).toBe(md('Model', noHeader()));
  expect(parseFactsFence(r.read('notes/model.md')).warnings).toEqual([]);
  expect((await engine.getPage('notes/model', { sourceId: r.id }))?.compiled_truth).toContain(CLAIM);
  const notices = await readUncommittedFenceRepairs(engine, [r.id]);
  expect(notices.map(n => n.path).sort()).toEqual(['notes/later.md', 'notes/model.md']);
  const doctor = await fenceIntegrityResult(engine, { sourceIds: [r.id] });
  expect(doctor).toMatchObject({ status: 'warn', details: { uncommitted_repairs: 2 } });
  expect(doctor.message).toContain('written and imported but not committed');
  const step = notices.find(n => n.path === 'notes/model.md')!.commit_step;
  expect(step).toContain("commit -m 'gbrain: repair fence in notes/model.md (no_header)'");
  execFileSync('bash', ['-c', step]);
  expect(git(r.root, 'log', '-1', '--format=%s')).toBe('gbrain: repair fence in notes/model.md (no_header)');
  expect((await readUncommittedFenceRepairs(engine, [r.id])).map(n => n.path)).toEqual(['notes/later.md']);
  expect((await fenceIntegrityResult(engine, { sourceIds: [r.id] })).details).toMatchObject({ uncommitted_repairs: 1 });
  expect(readFileSync(join(home, `${r.id}-target.md`), 'utf8')).toBe(md('Target', noHeader('Linked claim')));
}), 240_000);

test('a database-only page takes a revision-bound page write', async () => withEnv(env, async () => {
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6' } as never);
  const engine = legacyEngine;
  await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES('dbonly','dbonly','{}') ON CONFLICT DO NOTHING");
  await engine.putPage('notes/db-only', { type: 'note', title: 'Db only', compiled_truth: `Intro.\n\n${noHeader()}`, timeline: '' }, { sourceId: 'dbonly' });
  const h = helpers(engine, 'dbonly');
  transport(() => answer(CLAIM));
  const preview = await h.run();
  expect(preview.listing!.map(entry => [entry.item, entry.class])).toEqual([['dbonly:notes/db-only', 'llm']]);
  const applied = await h.run({ apply: true, expect: hashOf(preview), slugs: [] });
  expect(applied).toMatchObject({ repaired: 1 });
  expect(applied.outcome_items![0]!.detail).toMatchObject({ mode: 'db', slug: 'notes/db-only' });
  const page = await engine.getPage('notes/db-only', { sourceId: 'dbonly' });
  expect(parseFactsFence(page!.compiled_truth).warnings).toEqual([]);
  expect(parseFactsFence(page!.compiled_truth).facts.map(f => f.claim)).toEqual([CLAIM]);
}), 240_000);

test('--slug reaches a page the census has not judged and binds it into the hash and the apply command', async () => withEnv(env, async () => {
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6' } as never);
  const engine = legacyEngine;
  await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES('slugged','slugged','{}') ON CONFLICT DO NOTHING");
  await importFromContent(engine, 'notes/one', md('One', noHeader('Slug claim one')), { sourceId: 'slugged', noEmbed: true });
  await importFromContent(engine, 'notes/two', md('Two', noHeader('Slug claim two')), { sourceId: 'slugged', noEmbed: true });
  const h = helpers(engine, 'slugged');
  transport(() => answer('Slug claim one'));
  const one = await h.run({ slugs: ['notes/one'] });
  expect(one.listing!.map(entry => entry.item)).toEqual(['slugged:notes/one']);
  expect(one.apply_command).toBe(`gbrain repair fences --source slugged --slug notes/one --apply --expect ${hashOf(one)}`);
  expect(hashOf(one)).not.toBe(hashOf(await h.run()));
  let refused: unknown;
  try { await h.run({ apply: true, expect: hashOf(one) }); } catch (error) { refused = error; }
  expect((refused as OperationError).code).toBe('preview_changed');
  expect(await h.run({ apply: true, expect: hashOf(one), slugs: ['notes/one'] })).toMatchObject({ repaired: 1 });
  expect(parseFactsFence((await engine.getPage('notes/two', { sourceId: 'slugged' }))!.compiled_truth).warnings.length).toBeGreaterThan(0);
}), 240_000);

test('doctor --remediate: the plan counts the fences model estimate as paid, and a smaller --max-usd refuses the step before any call', () => each(async engine => {
  const s = await managed(engine, { 'people/model.md': md('Model', noHeader()) });
  await s.sync();
  transport(() => answer(CLAIM));
  const registry = [repairSpec('fences')];
  const steps = await planRepairSteps(engine, { registry });
  expect(steps).toHaveLength(1);
  expect(steps[0]).toMatchObject({ kind: 'fences', paid: true });
  expect(steps[0]!.llm_usd).toBeGreaterThan(0.01);
  const results = await runRepairSteps(engine, steps, { remote: false, remainingUsd: () => 0.01, registry });
  expect(results.map(r => r.status)).toEqual(['budget_refused']);
  expect(calls).toHaveLength(0);
  expect(s.read('people/model.md')).toBe(md('Model', noHeader()));
}), 240_000);

test('models.fence_repair: unset, the first measured model with a key (else none); set, it always runs; gbrain models reports which', async () => withEnv(env, async () => {
  const engine = legacyEngine;
  const report = async () => {
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => { chunks.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try { await runModels(engine, ['--json']); } finally { process.stdout.write = write; }
    return JSON.parse(chunks.join('')) as { per_task: Array<{ key: string; tier: string; resolved: string; source: string }> };
  };
  expect(FENCE_REPAIR_MEASURED_MODELS).toEqual(['openai:gpt-6.1-sol', 'anthropic:claude-opus-5-5']);
  expect(FENCE_REPAIR_MEASURED_MODELS.some(model => model.includes('fable'))).toBe(false);
  expect(await resolveFenceRepairModel(engine, { ANTHROPIC_API_KEY: 'k' })).toBe('anthropic:claude-opus-5-5');
  expect(await resolveFenceRepairModel(engine, { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' })).toBe('openai:gpt-6.1-sol');
  expect(await resolveFenceRepairModel(engine, { GEMINI_API_KEY: 'k' })).toBeNull();
  const before = (await report()).per_task.find(row => row.key === 'models.fence_repair')!;
  expect(before).toMatchObject({ tier: 'deep', resolved: 'anthropic:claude-opus-5-5', source: 'measured default' });
  await engine.setConfig('models.fence_repair', 'anthropic:claude-sonnet-5-5');
  const after = (await report()).per_task.find(row => row.key === 'models.fence_repair')!;
  expect(after).toMatchObject({ resolved: 'anthropic:claude-sonnet-5-5', source: 'config: models.fence_repair' });
  expect(await resolveFenceRepairModel(engine, {})).toBe('anthropic:claude-sonnet-5-5');
  await engine.executeRaw("DELETE FROM config WHERE key='models.fence_repair'");
}), 60_000);

test('no measured model has a key and models.fence_repair is unset: model candidates are held no_measured_model and nothing calls a model', () => each(async engine => {
  const s = await managed(engine, { 'people/model.md': md('Model', noHeader()) });
  await s.sync();
  transport(() => answer(CLAIM));
  await withEnv({ ANTHROPIC_API_KEY: undefined }, async () => {
    const preview = await s.run();
    expect(details(preview).held[0]).toMatchObject({ reason: 'no_measured_model', tier: 'llm' });
    expect(details(preview).held[0]!.resolution).toContain('gbrain config set models.fence_repair <provider:model>');
    expect(await s.run({ apply: true })).toMatchObject({ repaired: 0, remaining: { no_measured_model: 1 } });
    expect((await s.holds())[0]!.meta.fence_repair).toMatchObject({ reason: 'no_measured_model', tier: 'llm' });
  });
  expect(calls).toHaveLength(0);
}), 240_000);

test('a run past its deadline stops with time_budget before any item and calls no model', () => each(async engine => {
  const s = await managed(engine, { 'people/model.md': md('Model', noHeader()) });
  await s.sync();
  transport(() => answer(CLAIM));
  const runner = await repairRunner(engine, { apply: true, noEmbed: true, logger: quiet });
  const result = await runner.run('fences', await resolveRepairScope(engine, s.id), { deadline: Date.now() - 1 });
  expect(result.stopped).toMatchObject({ reason: 'time_budget' });
  expect(result).toMatchObject({ applied: 0, remaining: { time_budget: 1 } });
  expect(calls).toHaveLength(0);
}), 240_000);

test('two concurrent appliers at the daily cap: one model call, the other stops budget_exhausted, and the ledger never passes the cap', () => each(async engine => {
  const a = await managed(engine, { 'people/model.md': md('Model', noHeader()) });
  const b = await managed(engine, { 'people/model.md': md('Model', noHeader()) });
  await a.sync(); await b.sync();
  transport(() => answer(CLAIM));
  const day = new Date().toISOString().slice(0, 10);
  const [before] = await engine.executeRaw<{ spent: string | null }>("SELECT (reserved_usd + committed_usd)::text AS spent FROM budget_ledger WHERE scope='llm_repair' AND resolver_id='fences' AND local_date=$1::date", [day]);
  const spent = Number(before?.spent ?? 0);
  // Room for exactly one call today: one worst-case estimate, while a call settles at its real (much smaller) cost.
  const estimate = details(await a.run()).llm_items[0]!.estimate_usd;
  await engine.setConfig('fences.repair.max_usd_per_day', (spent + estimate + 0.001).toFixed(4));
  const results = await Promise.all([a.run({ apply: true }), b.run({ apply: true })]);
  expect(calls).toHaveLength(1);
  expect(results.map(r => r.repaired).sort()).toEqual([0, 1]);
  expect(results.find(r => r.repaired === 0)!.stopped).toMatchObject({ reason: 'budget_exhausted' });
  const [after] = await engine.executeRaw<{ spent: string; cap: string }>("SELECT (reserved_usd + committed_usd)::text AS spent, cap_usd::text AS cap FROM budget_ledger WHERE scope='llm_repair' AND resolver_id='fences' AND local_date=$1::date", [day]);
  expect(Number(after!.spent)).toBeLessThanOrEqual(Number(after!.cap));
  await engine.executeRaw("DELETE FROM config WHERE key='fences.repair.max_usd_per_day'");
}), 240_000);

test('the maintenance phase repairs held fences with the real kind, and the daily cap holds across ticks until it is raised', () => each(async engine => {
  // The phase runs across every active source, including earlier tests' sources that are still held, so the assertions count calls and ledger state.
  const a = await managed(engine, { 'people/model.md': md('Model', noHeader()) });
  const b = await managed(engine, { 'people/model.md': md('Model', noHeader()) });
  await a.sync(); await b.sync();
  transport(() => answer(CLAIM));
  const day = new Date().toISOString().slice(0, 10);
  const [before] = await engine.executeRaw<{ spent: string | null }>("SELECT (reserved_usd + committed_usd)::text AS spent FROM budget_ledger WHERE scope='llm_repair' AND resolver_id='fences' AND local_date=$1::date", [day]);
  const estimate = details(await a.run()).llm_items[0]!.estimate_usd;
  await engine.setConfig('fences.repair.max_usd_per_day', (Number(before?.spent ?? 0) + estimate + 0.001).toFixed(4));
  const tick = () => runFenceRepairPhase(engine, { dryRun: false, deadlineAtMs: Date.now() + 600_000 });
  const first = await tick();
  expect(first.details).toMatchObject({ mode: 'apply', stopped_reason: 'budget_exhausted' });
  expect(first.details).toMatchObject({ repaired_by_tier: { llm: 1 } });
  expect(calls).toHaveLength(1);
  // A second tick the same UTC day spends nothing more.
  const second = await tick();
  expect(second.details).toMatchObject({ stopped_reason: 'budget_exhausted', repaired_by_tier: { llm: 0 } });
  expect(calls).toHaveLength(1);
  await engine.executeRaw("DELETE FROM config WHERE key='fences.repair.max_usd_per_day'");
  const third = await tick();
  expect(third).toMatchObject({ status: 'ok' });
  expect(calls.length).toBeGreaterThanOrEqual(2);
  for (const s of [a, b]) { expect(parseFactsFence(s.read('people/model.md')).warnings).toEqual([]); expect(await s.holds()).toEqual([]); }
  expectNoSecrets([first, second, third]);
  // Paused: the phase never calls the kind.
  await engine.setConfig('fences.repair.enabled', 'false');
  expect(await tick()).toMatchObject({ status: 'skipped', details: { reason: 'disabled' } });
  await engine.executeRaw("DELETE FROM config WHERE key='fences.repair.enabled'");
}), 240_000);
