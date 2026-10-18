/**
 * #5988 doctor surfaces for held and repairable frontmatter. `git_held_files`
 * (Git-source holds) and `frontmatter_repairable` (files the repair can fix)
 * are wave findings the explicit-only `frontmatter` repair kind clears:
 * `doctor --remediation-plan --json` classifies them `explicit_kind_required`
 * with `gbrain repair frontmatter --source <id>`, and `--remediate
 * --include-repairs` never runs the kind. A deadline-partial scan is pending,
 * an outdated pre-commit hook is an operator finding, and the post-upgrade
 * banner tells the agent the next sync unblocks a source a file blocked.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { gitHoldDocs, readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { CODES } from '../src/core/error-registry.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import { gitHeldFilesCheck } from '../src/commands/doctor/checks/git-holds.ts';
import { frontmatterRepairableCheck, frontmatterRepairableFromReport } from '../src/commands/doctor/checks/frontmatter-repairable.ts';
import { frontmatterHookCheck } from '../src/commands/doctor/checks/frontmatter-hook.ts';
import { WAVE_CHECKS, runWaveChecks, type WaveFinding } from '../src/commands/doctor/wave-checks.ts';
import { classifyWaveFindings, runRemediate, runRemediationPlan } from '../src/commands/doctor/remediate.ts';
import { postUpgradeRecoveryBanner } from '../src/commands/doctor/upgrade-banner.ts';
import { repairForCheck } from '../src/core/repair/registry.ts';
import type { AuditReport } from '../src/core/brain-writer.ts';
import { capture } from './helpers/wave-scenarios.ts';
import { approvedRemediateArgs } from './helpers/remediate-approval.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const home = mkdtempSync(join(tmpdir(), 'gbrain-doctor-holds-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'content'); };
const note = (title: string) => `---\ntitle: ${title}\n---\nA synthetic observation.\n`;
const FOLDED = '---\ntitle: alice-example first line\nalice-example second line\n---\nA synthetic post.\n';
const AUTHOR = '---\ntitle: Payments roundup\nauthor: acme-example (citing fund-a / fund-b) (original: https://example.com/a/1)\n---\nA synthetic roundup.\n';
const OLD_HOOK = '#!/bin/sh\n# gbrain frontmatter pre-commit hook (v0.22.4+)\ngbrain frontmatter validate "$f"\n';

beforeAll(async () => {
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});

async function source(engine: BrainEngine, files: Record<string, string>) {
  const id = `fmh-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id);
  mkdirSync(root, { recursive: true }); git(root, 'init', '-q');
  for (const [path, content] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); }
  commit(root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const sync = (extra: Partial<SyncOpts> = {}) => performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true, ...extra });
  return { id, root, sync };
}

/** Each test sees only its own sources: the wave checks are brain-wide. */
async function each(run: (engine: BrainEngine) => Promise<void>) {
  await withEnv(env, async () => {
    for (const engine of engines) {
      try { await run(engine); }
      finally {
        await disposePersistenceConsumer(engine);
        await engine.unsetConfig('sync.holds');
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw("UPDATE sources SET local_path=NULL WHERE id LIKE 'fmh-%'");
        await engine.executeRaw("DELETE FROM op_checkpoints WHERE op LIKE 'sync-hold%' OR op LIKE 'managed-sync%'");
      }
    }
  });
}

const finding = (findings: Array<{ check_id: string }>, id: string) => findings.find(f => f.check_id === id);

test('the frontmatter kind owns both findings and both are host-only repair findings', () => {
  for (const id of ['git_held_files', 'frontmatter_repairable']) {
    const spec = WAVE_CHECKS.find(s => s.id === id)!;
    expect(spec).toMatchObject({ resolution: 'repair' });
    expect(typeof spec.hostOnly).toBe('string');
    expect(repairForCheck(id)).toMatchObject({ kind: 'frontmatter', explicit_only: true });
  }
  expect(WAVE_CHECKS.find(s => s.id === 'frontmatter_hook')).toMatchObject({ resolution: 'operator' });
});

test('every docs anchor a hold can name exists in write-refusals.md', () => {
  const guide = readFileSync(join(import.meta.dir, '..', 'docs', 'guides', 'write-refusals.md'), 'utf8');
  const anchors: string[] = [];
  for (const code of ['invalid_frontmatter', 'frontmatter_slug_conflict', 'file_too_large', 'content_rejected', 'rename_held', 'parser_regression'] as const) {
    anchors.push(gitHoldDocs(code));
    for (const reason of (CODES[code] as { reasons?: readonly string[] }).reasons ?? []) anchors.push(gitHoldDocs(code, reason as never));
  }
  expect(anchors).toContain('docs/guides/write-refusals.md#invalid_frontmatter-ambiguous_protected_key');
  for (const anchor of [...anchors, 'docs/guides/write-refusals.md#sync_parser_regression', 'docs/guides/write-refusals.md#changed_since_preview']) {
    expect(guide).toContain(`<a id="${anchor.split('#')[1]}"></a>`);
  }
});

test('a clean brain has no held, repairable or hook finding', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': note('A'), 'notes/b.md': note('B') });
  expect((await s.sync()).status).toBe('first_sync');
  expect(await gitHeldFilesCheck(engine)).toMatchObject({ status: 'ok', details: { held: 0 } });
  expect(await frontmatterRepairableCheck(engine, s.id)).toMatchObject({ status: 'ok', details: { repairable: 0, partial: false } });
  expect(await frontmatterHookCheck(engine)).toMatchObject({ status: 'ok' });
  const plan = JSON.parse((await capture(() => runRemediationPlan(engine, ['--remediation-plan', '--no-embed', '--json']))).out) as { findings: Array<{ check_id: string }> };
  for (const id of ['git_held_files', 'frontmatter_repairable', 'frontmatter_hook']) expect(finding(plan.findings, id)).toBeUndefined();
  expect((await postUpgradeRecoveryBanner(engine, 'host')).join('\n')).not.toMatch(/git_held_files|frontmatter_/);
}), 180_000);

test('holds and repairable files: the plan says explicit_kind_required with the source preview, and remediate never runs the kind', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': note('A'), 'notes/held-one.md': FOLDED, 'notes/held-two.md': FOLDED, 'notes/roundup.md': AUTHOR });
  const synced = await s.sync();
  expect(synced).toMatchObject({ status: 'first_sync', held_count: 2 });
  const preview = `gbrain repair frontmatter --source ${s.id}`;

  const held = await gitHeldFilesCheck(engine);
  expect(held).toMatchObject({ status: 'warn', details: { held: 2, source_ids: [s.id] },
    fix: { argv: ['gbrain', 'repair', 'frontmatter', '--source', s.id] } });
  expect(held.message).toContain(`${s.id}: 2 held (0 page(s) keep an older revision, 2 file(s) have no page)`);
  expect(held.message).toContain('notes/held-one.md [invalid_frontmatter/needs_interpretation]');
  expect(held.message).toContain('read-only for put_page until the file is repaired');
  expect(held.message).toContain(`gbrain sources status ${s.id}`);
  expect(held.message).toContain(preview);
  expect((held.details as { sources: Array<{ first: Array<{ why: string }> }> }).sources[0]!.first[0]!.why).toContain('needs an interpretation');

  const repairable = await frontmatterRepairableCheck(engine, s.id);
  expect(repairable).toMatchObject({ status: 'warn', details: { repairable: 3, source_ids: [s.id] } });
  expect((repairable.details as { sources: Array<{ by_code: Record<string, number> }> }).sources[0]!.by_code).toEqual({ needs_interpretation: 2, YAML_PARSE: 1 });
  expect(repairable.message).toContain(preview);

  const before = readFileSync(join(s.root, 'notes/held-one.md'), 'utf8');
  const plan = JSON.parse((await capture(() => runRemediationPlan(engine, ['--remediation-plan', '--no-embed', '--json']))).out) as {
    findings: Array<{ check_id: string; class: string; repair_kind?: string; command?: string }>; repair_steps?: Array<{ kind: string }> };
  for (const id of ['git_held_files', 'frontmatter_repairable']) {
    expect(finding(plan.findings, id)).toMatchObject({ class: 'explicit_kind_required', repair_kind: 'frontmatter', command: preview });
  }
  expect((plan.repair_steps ?? []).map(step => step.kind)).not.toContain('frontmatter');
  const text = (await capture(() => runRemediationPlan(engine, ['--remediation-plan', '--no-embed']))).out;
  expect(text).toContain(`  git_held_files: ${preview}`);

  const run = JSON.parse((await capture(async () => runRemediate(engine, await approvedRemediateArgs(engine,
    ['--remediate', '--yes', '--include-repairs', '--no-embed', '--max-usd', '0', '--json'])))).out) as {
    repairs?: Array<{ kind: string }>; findings: Array<{ check_id: string; class: string; command?: string }> };
  expect((run.repairs ?? []).map(r => r.kind)).not.toContain('frontmatter');
  expect(finding(run.findings, 'git_held_files')).toMatchObject({ class: 'explicit_kind_required', command: preview });
  expect(readFileSync(join(s.root, 'notes/held-one.md'), 'utf8')).toBe(before);
  expect((await readGitSourceHolds(engine, { sourceIds: [s.id] }))[0]?.count).toBe(2);

  const banner = (await postUpgradeRecoveryBanner(engine, 'host')).join('\n');
  expect(banner).toContain(`[AGENT]   git_held_files: 2 (explicit_kind_required; preview with: ${preview})`);
  expect(banner).not.toMatch(/--apply|--yes/);

  const escalated = await withEnv({ GBRAIN_SYNC_HOLD_ESCALATE_COUNT: '1' }, () => gitHeldFilesCheck(engine));
  expect(escalated.status).toBe('fail');
  expect(escalated.message).toContain(`Escalated: ${s.id} hold more than 1 files`);
}), 240_000);

test('a deadline-partial frontmatter scan reports pending, never clean or explicit', () => {
  const report: AuditReport = { ok: false, total: 0, errors_by_code: {}, partial: true, aborted_at_source: 'wiki', scanned_at: new Date().toISOString(),
    per_source: [{ source_id: 'wiki', source_path: '/tmp/wiki', total: 0, errors_by_code: {}, sample: [], ignoredMissingOpen: 0, status: 'partial', files_scanned: 3,
      repairable: { files: 1, by_code: { YAML_PARSE: 1 }, sample: ['notes/a.md'] } }] };
  const check = frontmatterRepairableFromReport(report, 1000);
  expect(check).toMatchObject({ status: 'warn', details: { partial: true, unscanned: ['wiki'] } });
  expect(check.message).toContain('PARTIAL SCAN');
  const spec = WAVE_CHECKS.find(s => s.id === 'frontmatter_repairable')!;
  const now: WaveFinding = { spec, check, state: 'finding' };
  expect(classifyWaveFindings([now], [now], { repairs: [], repairs_skipped: [] })).toEqual([expect.objectContaining({
    check_id: 'frontmatter_repairable', class: 'pending', repair_kind: 'frontmatter', instruction: expect.stringContaining('GBRAIN_DOCTOR_FM_TIMEOUT_MS') })]);

  const clean = frontmatterRepairableFromReport({ ...report, per_source: [{ ...report.per_source[0]!, repairable: { files: 0, by_code: {}, sample: [] } }] }, 1000);
  expect(clean.status).toBe('warn');
  expect(classifyWaveFindings([], [{ spec, check: clean, state: 'finding' }], { repairs: [], repairs_skipped: [] })[0]!.class).toBe('pending');
});

test('an older installed pre-commit hook is an operator finding naming install-hook --force', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': note('A') });
  mkdirSync(join(s.root, '.githooks'), { recursive: true });
  writeFileSync(join(s.root, '.githooks', 'pre-commit'), OLD_HOOK);
  const check = await frontmatterHookCheck(engine);
  expect(check).toMatchObject({ status: 'warn', details: { count: 1 }, fix: { argv: ['gbrain', 'frontmatter', 'install-hook', '--source', s.id, '--force'] } });
  expect(check.message).toContain(`gbrain frontmatter install-hook --source ${s.id} --force`);
  const waves = (await runWaveChecks(engine)).filter(f => f.spec.id === 'frontmatter_hook');
  expect(classifyWaveFindings(waves, waves, { repairs: [], repairs_skipped: [] })).toEqual([expect.objectContaining({
    check_id: 'frontmatter_hook', class: 'operator_required', instruction: expect.stringContaining('gbrain frontmatter install-hook --force') })]);
  const banner = (await postUpgradeRecoveryBanner(engine, 'host')).join('\n');
  expect(banner).toContain(`refresh it with gbrain frontmatter install-hook --source ${s.id} --force`);
}), 120_000);

test('post-upgrade: a source a file blocked is told the next sync recovers it, with the unblock and repair commands', () => each(async engine => {
  await engine.setConfig('sync.holds', 'fail');
  const s = await source(engine, { 'notes/broken.md': FOLDED, 'notes/ok.md': note('Ok') });
  expect((await s.sync()).status).toBe('blocked_by_failures');
  await engine.unsetConfig('sync.holds');
  const [failed] = await engine.executeRaw<{ request_id: string }>("SELECT request_id::text AS request_id FROM persistence_requests WHERE source_id=$1 AND state='failed'", [s.id]);
  // The exact text an older release stored for this refusal.
  await engine.executeRaw("UPDATE persistence_requests SET error_code='invalid_params',error_message=$2 WHERE request_id=$1::uuid",
    [failed!.request_id, 'Invalid YAML frontmatter: bad indentation of a mapping entry (3:1)']);

  const banner = (await postUpgradeRecoveryBanner(engine, 'host')).join('\n');
  expect(banner).toContain(`[AGENT]   frontmatter_holds: 1 source(s) are blocked by a file gbrain could not import (${s.id}).`);
  expect(banner).toContain('The next scheduled or manual sync recovers a blocked source automatically; '
    + `to do it now run gbrain sync --source ${s.id} --no-pull.`);
  expect(banner).toContain(`gbrain repair frontmatter --source ${s.id}`);

  expect(await s.sync()).toMatchObject({ status: 'first_sync', held_count: 1, converted_from_failed: [failed!.request_id] });
  expect((await postUpgradeRecoveryBanner(engine, 'host')).join('\n')).not.toContain('frontmatter_holds:');
}), 180_000);
