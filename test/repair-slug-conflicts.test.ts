/**
 * #6377 Lane B (T3): `gbrain repair slug-conflicts` end to end on a managed
 * source, with the judgment model behind the gateway's chat transport seam.
 *
 * Protects: the deterministic tier removes a stray `slug:` line when the
 * named slug has no page and no file, or names a page of another type with
 * no title word in common, through the coordinated file repair (file
 * rewritten, imported, hold cleared, Git commit `gbrain: repair frontmatter
 * slug in <path>` with the `gbrain-repair:` trailer, a content_repair
 * receipt); a slug that resolves through an alias to the file's own page is
 * `already_exempt`; a duplicate pair goes to the model tier at apply time
 * while the preview calls no model; a stubbed `merge_into` writes nothing,
 * records the verdict on the hold as codes and slugs, and `sync status`
 * renders `needs_human` with a paragraph naming the canonical; a stubbed
 * `remove_slug` applies through the same coordinated path; the memo makes a
 * second run on unchanged bytes spend nothing while a transient provider
 * error does not consume it; `changed_since_preview` and `--no-llm` write
 * nothing; the daily ledger is the fence repair's, so a prior fences spend
 * stops the run with `budget_exhausted` before any call; the location-only
 * rule on holds, receipts, results and commits.
 * Fails when: any of those paths regresses (a slug line removed for a likely
 * duplicate, a second paid call for the same bytes, model prose on a hold, a
 * write without the receipt or the trailer).
 * Why new: the kind is new in #6377.
 * Seams: __setChatTransportForTests (no provider call).
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setChatTransportForTests, configureGateway, resetGateway, type ChatOpts, type ChatResult } from '../src/core/ai/gateway.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { gitHoldItem, readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { dailyLedger, FENCE_REPAIR_LEDGER } from '../src/core/budget/daily-ledger.ts';
import { resolveRepairScope, type RepairResult } from '../src/core/repair/core.ts';
import { repairRunner, repairSpec } from '../src/core/repair/registry.ts';
import { parseRepairArgs } from '../src/commands/repair.ts';
import type { SlugConflictsPreviewDetails } from '../src/core/repair/slug-conflicts.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-slug-conflicts-'));
let engine: PGLiteEngine;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: 'sk-test-not-used' };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message = 'content') => { git(root, 'add', '-A'); git(root, 'commit', '-qm', message); return git(root, 'rev-parse', 'HEAD'); };
const quiet = { info() {}, warn() {}, error() {} };

// Body text that must never leave a file through a hold, a receipt, a result field or a commit message.
const SENTINEL_BODY = 'Sentinelbodyzr9 moved to Lisbon';
const WHY = 'Both describe the same synthetic founder.';
const page = (title: string, type: string, body: string, extra = '') => `---\ntitle: ${title}\ntype: ${type}\n${extra}---\n${body}\n`;
const answer = (text: string, stop: ChatResult['stopReason'] = 'end'): ChatResult => ({ text, blocks: [], stopReason: stop,
  usage: { input_tokens: 400, output_tokens: 30, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-opus-5-5', providerId: 'anthropic' });

let calls: ChatOpts[] = [];
function transport(reply: (opts: ChatOpts, n: number) => ChatResult | Error) {
  calls = [];
  __setChatTransportForTests(async opts => { calls.push(opts); const out = reply(opts, calls.length); if (out instanceof Error) throw out; return out; });
}

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterEach(() => { __setChatTransportForTests(null); });
afterAll(async () => {
  await withEnv(env, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
  resetGateway(); rmSync(home, { recursive: true, force: true });
});

async function managed(files: Record<string, string>) {
  const id = `slug-${randomUUID().replace(/-/g, '').slice(0, 16)}`, root = join(home, id);
  mkdirSync(root, { recursive: true }); git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
  const write = (path: string, content: string) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); };
  for (const [path, content] of Object.entries(files)) write(path, content);
  commit(root, 'fixture');
  writeFileSync(join(root, '.git', 'hooks', 'post-commit'), '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\n'); chmodSync(join(root, '.git', 'hooks', 'post-commit'), 0o755);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const sync = () => performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true });
  const holds = async () => (await readGitSourceHolds(engine, { sourceIds: [id] }))[0]?.holds ?? [];
  const run = async (opts: { apply?: boolean; expect?: string; only?: string[]; noLlm?: boolean; maxLlmUsd?: number } = {}) => {
    const runner = await repairRunner(engine, { apply: opts.apply === true, noEmbed: true, logger: quiet });
    return runner.run('slug-conflicts', await resolveRepairScope(engine, id), { explicit: true, sourceFlag: id, expect: opts.expect, only: opts.only, noLlm: opts.noLlm, maxLlmUsd: opts.maxLlmUsd });
  };
  return { id, root, write, sync, holds, run, read: (path: string) => readFileSync(join(root, path), 'utf8') };
}

async function gitEffectsSettled(sourceId: string) {
  for (let i = 0; i < 100; i++) {
    await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 10 });
    const open = await engine.executeRaw("SELECT 1 FROM persistence_effects WHERE source_id=$1 AND kind='git' AND state<>'committed'", [sourceId]);
    if (!open.length) return;
    await Bun.sleep(100);
  }
  throw new Error('git effects did not settle');
}

const details = (result: RepairResult) => result.details as unknown as SlugConflictsPreviewDetails;
const hashOf = (result: RepairResult) => result.apply_command.split('--expect ')[1]!.split(' ')[0]!;
const receipts = (sourceId: string) => engine.executeRaw<{ outcome: Record<string, any> }>("SELECT outcome FROM persistence_requests WHERE source_id=$1 AND outcome ? 'content_repair' ORDER BY sequence", [sourceId]);
const expectNoSecrets = (value: unknown) => { const text = typeof value === 'string' ? value : JSON.stringify(value); expect(text).not.toContain('Sentinelbodyzr9'); };
/** Result fields that carry no diff: the preview's diffs show file lines to the operator by design. */
const surfaceOf = (result: RepairResult) => ({ ...result, details: undefined });

function each(run: () => Promise<void>) {
  return withEnv(env, async () => {
    configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6' } as never);
    try { await run(); } finally { await disposePersistenceConsumer(engine); }
  });
}

test('registry: preview-bound, spends llm, clears no doctor check, not explicit-only; the CLI takes --only and --no-llm', () => {
  const spec = repairSpec('slug-conflicts');
  expect(spec).toMatchObject({ preview_bound: true, spends: 'llm', checks: [], embeds: 'effect' });
  expect(spec.explicit_only).toBeUndefined();
  expect(parseRepairArgs(['slug-conflicts', '--source', 's', '--only', 'notes/a.md', '--no-llm', '--apply', '--expect', 'abc'])).toMatchObject({ kind: 'slug-conflicts', only: ['notes/a.md'], noLlm: true, expect: 'abc' });
});

test('deterministic tier: a stray slug (no page, no file) and a slug naming a page of another type lose the line; an alias to the own page is exempt; the preview writes nothing', () => each(async () => {
  const s = await managed({
    'companies/acme-example.md': page('Acme Widgets', 'company', 'A synthetic company.'),
    'people/carol-example.md': page('Carol Example', 'person', 'A synthetic person.'),
    'notes/stray.md': page('Stray Note', 'note', `A note from a template. ${SENTINEL_BODY}`, 'slug: notes/nowhere-at-all\n'),
    'people/bob-example.md': page('Bob Example', 'person', 'A synthetic person who works at the company.', 'slug: companies/acme-example\n'),
  });
  expect((await s.sync()).held_count).toBe(2);
  // An alias to the file's own page: held by the screen, exempt for the lane.
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.write_sources', $1, true)", [JSON.stringify([s.id])]);
    await tx.executeRaw('INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ($1, $2, $3)', [s.id, 'people/carol', 'people/carol-example']);
  });
  s.write('people/carol-example.md', page('Carol Example', 'person', 'A synthetic person.', 'slug: people/carol\n')); commit(s.root, 'alias slug');
  expect((await s.sync()).held_count).toBe(3);
  transport(() => answer('{"action":"remove_slug"}'));
  const preview = await s.run();
  expect(calls).toHaveLength(0);
  expect(preview.listing!.map(entry => [entry.item, entry.class]).sort()).toEqual([
    [`${s.id}:notes/stray.md`, 'deterministic'], [`${s.id}:people/bob-example.md`, 'deterministic'], [`${s.id}:people/carol-example.md`, 'already_exempt']]);
  expect(details(preview).counts).toEqual({ deterministic: 2, llm: 0, held: 0, skipped: 1 });
  expect(details(preview).diffs.map(d => d.rule).sort()).toEqual(['absent_page', 'different_type']);
  expect(details(preview).diffs[0]!.diff).toContain('-slug: ');
  expect(preview.cost.llm_usd).toBe(0);
  expect(preview.apply_command).toBe(`gbrain repair slug-conflicts --source ${s.id} --apply --expect ${hashOf(preview)}`);
  expect(s.read('notes/stray.md')).toContain('slug: notes/nowhere-at-all');
  const applied = await s.run({ apply: true, expect: hashOf(preview) });
  expect(applied).toMatchObject({ mode: 'apply', applied: 2, repaired: 2, outcomes: { repaired: 2 } });
  expect(calls).toHaveLength(0);
  expect(s.read('notes/stray.md')).toBe(page('Stray Note', 'note', `A note from a template. ${SENTINEL_BODY}`));
  expect(s.read('people/bob-example.md')).not.toContain('slug:');
  expect((await engine.getPage('people/bob-example', { sourceId: s.id }))?.compiled_truth).toContain('works at the company');
  const holds = await s.holds();
  expect(holds.map(h => h.path)).toEqual(['people/carol-example.md']);
  // The receipt and the commit: actor, tier, confidence, hashes; the subject names the path and the trailer the hold code.
  const rows = await receipts(s.id);
  expect(rows.map(r => r.outcome.content_repair.tier)).toEqual(['deterministic', 'deterministic']);
  expect(rows[0]!.outcome.content_repair).toMatchObject({ actor: 'content-repair', hold_code: 'frontmatter_slug_conflict', action: 'remove_slug', confidence: 'high', model: null, cost_usd: 0 });
  await gitEffectsSettled(s.id);
  const log = git(s.root, 'log', '--format=%B');
  expect(log).toContain('gbrain: repair frontmatter slug in notes/stray.md');
  expect(log).toContain('gbrain-repair: frontmatter_slug_conflict deterministic high');
  expect(git(s.root, 'log', '-1', '--format=%(trailers:key=gbrain-repair,valueonly)')).toMatch(/^frontmatter_slug_conflict deterministic high/);
  expect(git(s.root, 'status', '--porcelain')).toBe('');
  expectNoSecrets([holds, rows, surfaceOf(applied), log]);
  // The hold fix of the remaining (exempt) hold names the content repair preview.
  expect(gitHoldItem(holds[0]!).fix.argv).toEqual(['gbrain', 'repair', 'content', '--source', s.id, '--only', 'people/carol-example.md']);
}), 240_000);

test('model tier: a duplicate pair is judged at apply time; merge_into writes nothing and names the canonical for a person; the memo spends nothing twice; remove_slug applies through the coordinated path', () => each(async () => {
  const s = await managed({
    'people/alice-example.md': page('Alice Example', 'person', 'A synthetic founder, first met in 2024.'),
    'people/alice-example-2.md': page('Alice Example', 'person', `A synthetic founder. Possible duplicate of people/alice-example. ${SENTINEL_BODY}`, 'slug: people/alice-example\n'),
    'people/dan-example.md': page('Dan Example', 'person', 'A synthetic engineer.'),
    'people/dan-other.md': page('Dan Other Example', 'person', 'A different synthetic person.', 'slug: people/dan-example\n'),
  });
  expect((await s.sync()).held_count).toBe(2);
  transport(() => answer('{"action":"merge_into","canonical":"people/alice-example","why":"' + WHY + '"}'));
  const preview = await s.run();
  expect(calls).toHaveLength(0);
  expect(preview.listing!.map(entry => entry.class)).toEqual(['llm', 'llm']);
  expect(details(preview).llm_items.map(i => i.named).sort()).toEqual(['people/alice-example', 'people/dan-example']);
  expect(preview.cost.llm_usd).toBeGreaterThan(0);
  expect(preview.cost.llm_cap_remaining_usd).toBe(1);
  expect(details(preview).model).toBe('anthropic:claude-opus-5-5');
  // --no-llm holds both without a call and records the state.
  const free = await s.run({ apply: true, noLlm: true });
  expect(free).toMatchObject({ applied: 0, remaining: { llm_disabled: 2 } });
  expect(calls).toHaveLength(0);
  expect((await s.holds())[0]!.meta.content_repair).toMatchObject({ action: 'pending', reason: 'llm_disabled', next_attempt_after: null });
  // The model: merge_into for the duplicate, remove_slug for the other.
  transport(opts => answer(JSON.stringify(opts.messages).includes('people/dan-other') ? '{"action":"remove_slug","why":"Different people."}' : `{"action":"merge_into","canonical":"people/alice-example","why":"${WHY}"}`));
  const applied = await s.run({ apply: true });
  expect(calls).toHaveLength(2);
  expect(applied).toMatchObject({ applied: 1, repaired: 1, remaining: { merge_recommended: 1 }, outcomes: { repaired: 1, held: 1 } });
  expect(applied.cost.llm_usd).toBeGreaterThan(0);
  const prompt = `${calls[0]!.system}\n${JSON.stringify(calls[0]!.messages)}`;
  expect(prompt).toContain('people/alice-example-2');
  expect(prompt).toContain('exactly one JSON object');
  // merge_into: nothing written, the hold carries codes and slugs (never the model's sentence), the run output carries why.
  expect(s.read('people/alice-example-2.md')).toContain('slug: people/alice-example');
  const held = applied.outcome_items!.find(o => o.outcome === 'held')!;
  expect(held).toMatchObject({ reason: 'merge_recommended', detail: { action: 'merge_into', canonical: 'people/alice-example', why: WHY, tier: 'llm' } });
  const holds = await s.holds();
  expect(holds.map(h => h.path)).toEqual(['people/alice-example-2.md']);
  expect(holds[0]!.meta.content_repair).toMatchObject({ action: 'merge_into', reason: 'merge_recommended', canonical: 'people/alice-example', named: 'people/alice-example', type: 'person', model: 'anthropic:claude-opus-5-5', next_attempt_after: null });
  expect(JSON.stringify(holds[0]!.meta)).not.toContain(WHY);
  const status = await readSyncStatus(engine, s.id);
  expect(status.needs_human).toBe(true);
  expect(status.human_reason).toContain('`people/alice-example`');
  expect(status.human_reason).toContain('`people/alice-example-2.md`');
  expect(status.human_reason).toContain('gbrain does not merge pages by itself yet');
  expect(status.human_reason).not.toContain(WHY);
  expect(status.next).toMatchObject({ actor: 'user', argv: ['gbrain', 'repair', 'content', '--source', s.id, '--only', 'people/alice-example-2.md'] });
  const item = gitHoldItem(holds[0]!);
  expect(item.docs).toBe('docs/guides/write-refusals.md#merge_recommended');
  expect(item.fix.user_message).toContain('people/alice-example');
  // remove_slug: written through the coordinated path with the llm receipt and trailer.
  expect(s.read('people/dan-other.md')).not.toContain('slug:');
  const rows = await receipts(s.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.outcome.content_repair).toMatchObject({ tier: 'llm', confidence: 'medium', model: 'anthropic:claude-opus-5-5' });
  expect(rows[0]!.outcome.content_repair.cost_usd).toBeGreaterThan(0);
  await gitEffectsSettled(s.id);
  const log = git(s.root, 'log', '--format=%B');
  expect(log).toContain('gbrain: repair frontmatter slug in people/dan-other.md');
  expect(log).toContain('gbrain-repair: frontmatter_slug_conflict llm medium');
  // The memo: the same bytes, pages, model and prompt are never sent again; the hold keeps its verdict.
  const again = await s.run({ apply: true });
  expect(calls).toHaveLength(2);
  expect(again).toMatchObject({ applied: 0, remaining: { merge_recommended: 1 } });
  expect(again.cost.llm_usd).toBe(0);
  expect(again.outcome_items![0]!.detail).toMatchObject({ memo: 'judged_before' });
  expect((await s.holds())[0]!.meta.content_repair).toMatchObject({ action: 'merge_into', canonical: 'people/alice-example' });
  // A re-screen of the same bytes keeps the verdict; a changed file drops it and earns a new judgment.
  await s.sync();
  expect((await s.holds())[0]!.meta.content_repair).toMatchObject({ action: 'merge_into' });
  s.write('people/alice-example-2.md', page('Alice Example', 'person', 'A synthetic founder, edited.', 'slug: people/alice-example\n')); commit(s.root, 'edit');
  await s.sync();
  expect((await s.holds())[0]!.meta.content_repair).toBeUndefined();
  transport(() => answer('{"action":"needs_human"}'));
  const undecided = await s.run({ apply: true });
  expect(calls).toHaveLength(1);
  expect(undecided).toMatchObject({ applied: 0, remaining: { content_repair_needs_human: 1 } });
  expect((await s.holds())[0]!.meta.content_repair).toMatchObject({ action: 'needs_human', reason: 'content_repair_needs_human', next_attempt_after: null });
  const undecidedStatus = await readSyncStatus(engine, s.id);
  expect(undecidedStatus.needs_human).toBe(true);
  expect(undecidedStatus.human_reason).toContain('could not decide');
  expect(gitHoldItem((await s.holds())[0]!).docs).toBe('docs/guides/write-refusals.md#content_repair_needs_human');
  expectNoSecrets([await s.holds(), rows, surfaceOf(applied), surfaceOf(again), log, status]);
}), 240_000);

test('a transient provider error keeps the memo and schedules a retry; changed_since_preview writes nothing; the fence ledger counts, so a prior fences spend stops the run before any call', () => each(async () => {
  const s = await managed({
    'people/erin-example.md': page('Erin Example', 'person', 'A synthetic founder.'),
    'people/erin-example-2.md': page('Erin Example', 'person', 'Another record of the same synthetic founder.', 'slug: people/erin-example\n'),
  });
  expect((await s.sync()).held_count).toBe(1);
  transport(() => Object.assign(new Error('rate limited'), { status: 429 }));
  const down = await s.run({ apply: true });
  expect(calls).toHaveLength(1);
  expect(down).toMatchObject({ applied: 0, remaining: { llm_unavailable: 1 } });
  const state = (await s.holds())[0]!.meta.content_repair!;
  expect(state).toMatchObject({ action: 'pending', reason: 'llm_unavailable' });
  expect(Date.parse(state.next_attempt_after!)).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  expect(gitHoldItem((await s.holds())[0]!).fix.why).toContain('tries again');
  // The memo was not consumed: the next run asks again.
  transport(() => answer('{"action":"needs_human"}'));
  const preview = await s.run();
  expect(calls).toHaveLength(0);
  // changed_since_preview: the file moved after the preview, so the approved set skips it without a call.
  const edited = page('Erin Example', 'person', 'Another record of the same synthetic founder, edited.', 'slug: people/erin-example\n');
  s.write('people/erin-example-2.md', edited);
  const stale = await s.run({ apply: true, expect: hashOf(preview) });
  expect(stale).toMatchObject({ applied: 0, outcomes: { skipped: 1 }, remaining: { changed_since_preview: 1 } });
  expect(calls).toHaveLength(0);
  expect(s.read('people/erin-example-2.md')).toBe(edited);
  s.write('people/erin-example-2.md', page('Erin Example', 'person', 'Another record of the same synthetic founder.', 'slug: people/erin-example\n'));
  // One shared daily cap: a fences spend committed today leaves nothing for the judgment.
  const ledger = dailyLedger(engine, FENCE_REPAIR_LEDGER);
  const day = await ledger.readDay();
  const cap = Math.round((day.committedUsd + day.reservedUsd + 0.01) * 10_000) / 10_000;
  await engine.setConfig('fences.repair.max_usd_per_day', String(cap));
  const reserved = await ledger.reserve(0.009, { capUsd: cap });
  expect(reserved.ok).toBe(true);
  if (reserved.ok) { await ledger.dispatch(reserved.reservation.id); await ledger.settle(reserved.reservation.id, 0.0095); }
  const capped = await s.run({ apply: true });
  expect(calls).toHaveLength(0);
  expect(capped).toMatchObject({ applied: 0 });
  expect(capped.stopped).toMatchObject({ reason: 'budget_exhausted', fix: { argv: ['gbrain', 'config', 'set', 'fences.repair.max_usd_per_day', '<usd>'], consent: ['paid'] } });
  expect(capped.stopped!.message).toMatch(/resets at \d{4}-\d{2}-\d{2}T00:00:00\.000Z/);
  expect((await s.holds())[0]!.meta.content_repair).toMatchObject({ action: 'pending', reason: 'budget_exhausted' });
  expect((await s.holds())[0]!.meta.content_repair!.next_attempt_after).toMatch(/T00:00:00\.000Z$/);
  expect(gitHoldItem((await s.holds())[0]!).fix).toMatchObject({ consent: ['paid'], argv: ['gbrain', 'config', 'set', 'fences.repair.max_usd_per_day', '<usd>'] });
  await engine.executeRaw("DELETE FROM config WHERE key='fences.repair.max_usd_per_day'");
  // With the cap back, the judgment runs once.
  expect(await s.run({ apply: true })).toMatchObject({ remaining: { content_repair_needs_human: 1 } });
  expect(calls).toHaveLength(1);
  expectNoSecrets([await s.holds(), surfaceOf(down), surfaceOf(capped)]);
}), 240_000);
