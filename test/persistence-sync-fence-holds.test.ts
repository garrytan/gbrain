/**
 * #6188: a malformed facts or takes fence never blocks a managed sync; the
 * file is held, and every surface routes it to `gbrain repair fences` (that
 * file's preview for one hold, the source's for a source). A fence the screen refuses is held at freeze; a fence refused
 * only while being prepared against the stored page (a stored-row collision)
 * is held in the same invocation from its failed receipt; a cursor an older
 * release blocked converts on the next sync with no `--retry-failed`.
 * `sync.holds=fail` keeps blocking, with the typed refusal. Holds, results,
 * receipts and printed output carry locations only, never a claim, holder or
 * kind. Synthetic content only.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { gitHoldStatusLines, readGitHoldStatuses } from '../src/core/persistence/connector-status.ts';
import { gitHeldFilesCheck, fenceHoldsBannerNote, frontmatterHoldsBannerNote } from '../src/commands/doctor/checks/git-holds.ts';
import { retryHeld } from '../src/commands/sources-retry-held.ts';
import { postUpgradeRecoveryBanner } from '../src/commands/doctor/upgrade-banner.ts';
import { remoteWaveHandoff } from '../src/commands/doctor/wave-checks.ts';
import { printSyncResult, type SyncOpts, type SyncResult } from '../src/commands/sync.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { waitFor } from './helpers/wait-for.ts';
import { readFileSync } from 'node:fs';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { parseTakesFence } from '../src/core/takes-fence.ts';
import { listFenceCandidates, runFenceCensus } from '../src/core/fence-repair/census.ts';
import { FENCE_TREND_OP } from '../src/core/fence-repair/census-store.ts';

const backends = testBackends();
const home = mkdtempSync(join(tmpdir(), 'gbrain-fence-holds-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message = 'content') => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); return git(root, 'rev-parse', 'HEAD'); };

// Unique strings that must never leave the file: a claim, a holder and a kind.
const CLAIM = 'Sentinelclaimzq7 ships quarterly', HOLDER = 'Sentinelholderzq7 Example', KIND = 'sentinelkindzq7';
const SECRETS = [CLAIM, HOLDER, KIND, 'Sentinelclaimzq7', 'Sentinelholderzq7'];
const T = '<!--- gbrain:takes:begin -->', TE = '<!--- gbrain:takes:end -->';
const TH = '| # | claim | kind | who | weight | since | source |\n|---|---|---|---|---|---|---|';
const take = (n: number, claim = 'Synthetic take', who = 'brain', kind = 'take') => `| ${n} | ${claim} | ${kind} | ${who} | 0.7 | 2026-01 | chat |`;
const takesPage = (title: string, ...rows: string[]) => `---\ntitle: ${title}\n---\nA synthetic page.\n\n${T}\n${TH}\n${rows.join('\n')}\n${TE}\n`;
const note = (title: string) => `---\ntitle: ${title}\n---\nA synthetic observation.\n`;
const MALFORMED = takesPage('Malformed', take(1, CLAIM, HOLDER));

beforeAll(async () => {
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});

async function source(engine: BrainEngine, files: Record<string, string>, config: Record<string, string> = {}, durable = false) {
  const id = `fence-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id);
  const write = (path: string, content: string) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); };
  mkdirSync(root, { recursive: true }); git(root, 'init', '-q');
  // The Git target effect commits (durability on: the managed post-commit hook) with the checkout's own identity.
  git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
  if (durable) { writeFileSync(join(root, '.git', 'hooks', 'post-commit'), '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\nexit 0\n'); chmodSync(join(root, '.git', 'hooks', 'post-commit'), 0o755); }
  for (const [path, content] of Object.entries(files)) write(path, content);
  commit(root, 'fixture');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, root, JSON.stringify(config)]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const sync = (extra: Partial<SyncOpts> = {}) => performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true, ...extra });
  const holds = async () => (await readGitSourceHolds(engine, { sourceIds: [id] }))[0]?.holds ?? [];
  const lastCommit = async () => (await engine.executeRaw<{ last_commit: string }>('SELECT last_commit FROM sources WHERE id=$1', [id]))[0]!.last_commit;
  const failedRequests = () => engine.executeRaw<{ request_id: string; error_code: string; error_message: string | null; error_detail: Record<string, unknown> | null }>(
    "SELECT request_id::text AS request_id,error_code,error_message,error_detail FROM persistence_requests WHERE source_id=$1 AND state IN ('failed','conflict') ORDER BY sequence", [id]);
  const ledger = () => engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='managed-sync-failure' AND completed_keys::text LIKE $1", [`%${id}%`]);
  const storedTake = async (slug: string, rowNum: number, claim: string) => engine.transaction(tx => withCoordinatedWrite(tx, [id], () => tx.executeRaw(
    `INSERT INTO takes(page_id,row_num,claim,kind,holder,weight) SELECT id,$3,$4,'take','brain',0.5 FROM pages WHERE source_id=$1 AND slug=$2`, [id, slug, rowNum, claim]), TEST_WRITE_ATTRIBUTION));
  return { id, root, write, sync, holds, lastCommit, failedRequests, ledger, storedTake };
}

async function each(run: (engine: BrainEngine) => Promise<void>) {
  await withEnv(env, async () => {
    for (const engine of engines) {
      try { await run(engine); }
      finally { await disposePersistenceConsumer(engine); await engine.unsetConfig('sync.holds'); await engine.unsetConfig('fences.normalize'); }
    }
  });
}

const printed = (result: SyncResult) => { let out = ''; printSyncResult(result, { write: (text: string) => { out += text; return true; } } as NodeJS.WriteStream); return out; };
const expectNoSecrets = (text: string) => { for (const secret of SECRETS) expect(text).not.toContain(secret); };

test('a malformed fence among clean files: the sync finishes, holds that file with its location, and the fix imports it', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': note('A'), 'notes/b.md': note('B'), 'people/malformed.md': MALFORMED });
  const head = git(s.root, 'rev-parse', 'HEAD');
  const result = await s.sync();
  expect(result).toMatchObject({ status: 'first_sync', added: 2, held_count: 1, holds_outstanding: 1 });
  expect(await s.lastCommit()).toBe(head);
  expect(await engine.getPage('people/malformed', { sourceId: s.id })).toBeNull();
  expect(result.held![0]).toMatchObject({ path: 'people/malformed.md', code: 'invalid_fence', reason: 'holder_unresolved', stale: false,
    fence: { reason: 'holder_unresolved', fence: 'takes', section: 'body', rows: [1], columns: ['who'] }, docs: 'docs/guides/write-refusals.md#fence-holder_unresolved' });
  // #6188 PR4 (D6, Codex DX #6): the hold's fix is that file's fence repair preview, the source's is the source preview. Never frontmatter advice.
  // No maintenance run is active in this brain, so the fix is the preview, then the apply (E35), and the hold records the file line (D16).
  const preview = ['gbrain', 'repair', 'fences', '--source', s.id, '--only', 'people/malformed.md'];
  expect(result.held![0]!.fix.argv).toEqual(preview);
  expect(result.held![0]!.fix.then?.argv).toEqual([...preview, '--apply']);
  expect(result.held![0]).toMatchObject({ line: 9, fence: { tier: 'resolver', auto_retry: false, next_attempt_after: null, classes: ['holder_unresolved'] } });
  expect(result.holds_fix!.argv).toEqual(['gbrain', 'repair', 'fences', '--source', s.id]);
  for (const text of [JSON.stringify(result.held), result.holds_fix!.why]) expect(text).not.toContain('repair frontmatter');
  const text = printed(result);
  expect(text).toContain('Held people/malformed.md: invalid_fence (holder_unresolved) in the takes fence (body), row 1, column who, at line 9');
  expect(text).toContain(`gbrain repair fences --source ${s.id} --only people/malformed.md`);
  const status = (await readGitHoldStatuses(engine, [s.id])).get(s.id)!;
  const lines = gitHoldStatusLines(s.id, status).join('\n');
  expect(lines).toContain('people/malformed.md: invalid_fence (holder_unresolved) in the takes fence (body)');
  // Privacy sentinel: no claim, holder or kind text in holds, results, printed output or status.
  const rows = await engine.executeRaw<{ completed_keys: unknown }>("SELECT completed_keys FROM op_checkpoints WHERE op LIKE 'sync-hold%' AND fingerprint LIKE $1", [`${s.id}:%`]);
  for (const blob of [JSON.stringify(rows), JSON.stringify(result), text, lines, JSON.stringify(status)]) expectNoSecrets(blob);
  expect(lines).toContain(`gbrain repair fences --source ${s.id} --only people/malformed.md`);
  // Doctor routes a fence-only source to the fence repair preview, never to frontmatter repair.
  const doctor = await gitHeldFilesCheck(engine, [s.id]);
  expect(doctor).toMatchObject({ status: 'warn', fix: { argv: ['gbrain', 'repair', 'fences', '--source', s.id] }, details: { fences: 1, auto_repair: { active: false } } });
  expect(doctor.message).toContain(`gbrain repair fences --source ${s.id}`);
  expect(doctor.message).not.toContain('repair frontmatter');
  // retry-held names the fence repair preview for what still refuses.
  const retry = (await retryHeld(engine, s.id, { dryRun: false })).next_action;
  expect(retry).toContain(`gbrain repair fences --source ${s.id}`);
  expect(retry).not.toContain('repair frontmatter');

  s.write('people/malformed.md', takesPage('Malformed', take(1, 'Synthetic take', 'world'))); commit(s.root, 'fix the holder');
  const fixed = await s.sync();
  expect(fixed).toMatchObject({ status: 'synced', added: 1 });
  expect(await s.holds()).toEqual([]);
  expect(await engine.getPage('people/malformed', { sourceId: s.id })).not.toBeNull();
}), 180_000);

test('forced probe: a fence that passes the screen but collides with a stored take is held in the same invocation', () => each(async engine => {
  const s = await source(engine, { 'people/probe.md': takesPage('Probe', take(1)), 'notes/a.md': note('A') });
  expect((await s.sync()).status).toBe('first_sync');
  const before = (await engine.readPageSnapshot('people/probe', { sourceId: s.id }))!.revision;
  await s.storedTake('people/probe', 2, 'Database-only take');
  s.write('people/probe.md', takesPage('Probe', take(1), take(2, CLAIM)));
  s.write('notes/b.md', note('B'));
  const head = commit(s.root, 'collide with a stored take');
  const result = await s.sync();
  // One invocation: synced, the checkpoint advanced, one hold, one failed receipt, no failure-ledger row.
  expect(result).toMatchObject({ status: 'synced', added: 1, held_count: 1 });
  expect(await s.lastCommit()).toBe(head);
  const failed = await s.failedRequests();
  expect(failed).toHaveLength(1);
  expect(result.converted_from_failed).toEqual([failed[0]!.request_id]);
  expect(failed[0]).toMatchObject({ error_code: 'take_row_collision', error_detail: { origin: 'fence', fence: { version: 1, reason: 'stored_row_collision', fence: 'takes', section: 'body', rows: [2] } } });
  expect(failed[0]!.error_message).toMatch(/^Fence stored_row_collision: in the takes fence \(body\), row 2\./);
  expect(await s.ledger()).toEqual([]);
  expect(result.held![0]).toMatchObject({ path: 'people/probe.md', code: 'invalid_fence', reason: 'prepare_time', stale: true,
    fence: { reason: 'stored_row_collision', fence: 'takes', section: 'body', rows: [2] }, docs: 'docs/guides/write-refusals.md#fence-prepare_time' });
  // A stored-row collision is a manual edit: that file's preview names it, then the sync imports the corrected file.
  expect(result.held![0]!.fix.argv).toEqual(['gbrain', 'repair', 'fences', '--source', s.id, '--only', 'people/probe.md']);
  expect(result.held![0]!.fix.then?.argv).toEqual(['gbrain', 'sync', '--source', s.id, '--no-pull']);
  expect((await engine.readPageSnapshot('people/probe', { sourceId: s.id }))!.revision).toBe(before);
  expect(await engine.executeRaw('SELECT row_num,claim FROM takes k JOIN pages p ON p.id=k.page_id WHERE p.source_id=$1 AND p.slug=$2 ORDER BY row_num', [s.id, 'people/probe']))
    .toEqual([{ row_num: 1, claim: 'Synthetic take' }, { row_num: 2, claim: 'Database-only take' }]);
  for (const blob of [JSON.stringify(result), printed(result), JSON.stringify(failed)]) { expectNoSecrets(blob); expect(blob).not.toContain('repair frontmatter'); }
  // The next run neither re-admits the held bytes nor mints another receipt.
  expect(await s.sync()).toMatchObject({ status: 'up_to_date', holds_outstanding: 1 });
  expect(await s.failedRequests()).toHaveLength(1);
}), 180_000);

test('sync.holds=fail blocks with the typed refusal; the next sync after the upgrade converts the legacy receipt with no --retry-failed', () => each(async engine => {
  await engine.setConfig('sync.holds', 'fail');
  const s = await source(engine, { 'people/malformed.md': MALFORMED, 'notes/ok.md': note('Ok') });
  const blocked = await s.sync();
  expect(blocked).toMatchObject({ status: 'blocked_by_failures', failureCodes: [{ code: 'invalid_params', count: 1 }] });
  expect(blocked.managedWrite?.message ?? '').toMatch(/^Fence holder_unresolved: in the takes fence \(body\)/);
  const [failed] = await s.failedRequests();
  // The exact text a pre-#6188 release stored for this refusal, with no durable detail.
  await engine.executeRaw('UPDATE persistence_requests SET error_message=$2,error_detail=NULL WHERE request_id=$1::uuid',
    [failed!.request_id, 'A canonical facts or takes fence cannot be parsed losslessly.']);
  const fenceNote = (await fenceHoldsBannerNote(engine)) ?? '';
  for (const part of [`gbrain sync --source ${s.id} --no-pull`, 'recovers each with no command', 'malformed fence(s) are known so far',
    'nothing repairs them by itself until a maintenance run is active', 'Preview (read-only, no model call): gbrain repair fences',
    'gbrain config set fences.repair.enabled false']) expect(fenceNote).toContain(part);
  expect(fenceNote).not.toMatch(/--apply|repairable after the user agrees/);
  expectNoSecrets(fenceNote);
  // The whole banner: the fence_holds note, the fence_integrity finding (no maintenance run is active here) and no applying command.
  const banner = (await postUpgradeRecoveryBanner(engine, 'host')).join('\n');
  expect(banner).toContain('[AGENT]   fence_holds: ');
  expect(banner).toMatch(/\[AGENT\] {3}fence_integrity: \d+ \(not repaired automatically \(no maintenance run is active\); preview with: gbrain repair fences\)/);
  expect(banner).not.toMatch(/--apply|--yes/);
  expectNoSecrets(banner);
  // The remote doctor's host-action line names no path and no claim.
  const remote = (await remoteWaveHandoff(engine, [s.id])).find(line => line.name === 'fence_integrity')!;
  expect(remote).toMatchObject({ status: 'warn', details: { host_action: { check_id: 'fence_integrity', state: 'action_required' } } });
  for (const leak of ['people/malformed', s.root]) expect(JSON.stringify(remote)).not.toContain(leak);
  expectNoSecrets(JSON.stringify(remote));
  expect((await frontmatterHoldsBannerNote(engine)) ?? '').not.toContain(s.id);
  await engine.unsetConfig('sync.holds');
  const converted = await s.sync();
  expect(converted.converted_from_failed).toEqual([failed!.request_id]);
  expect(converted).toMatchObject({ status: 'first_sync', held_count: 1 });
  expect(converted.held![0]).toMatchObject({ path: 'people/malformed.md', code: 'invalid_fence', fence: { fence: 'takes', section: 'body' } });
  expect(await engine.getPage('notes/ok', { sourceId: s.id })).not.toBeNull();
  expect(await fenceHoldsBannerNote(engine)).toBeNull();
}), 180_000);

test('a legacy stored-row receipt holds the same bytes from the receipt; a compacted receipt converts only through the re-screen', () => each(async engine => {
  const s = await source(engine, { 'people/probe.md': takesPage('Probe', take(1)) });
  await s.sync();
  await s.storedTake('people/probe', 2, 'Database-only take');
  s.write('people/probe.md', takesPage('Probe', take(1), take(2, 'Incoming take'))); commit(s.root, 'collide');
  await engine.setConfig('sync.holds', 'fail');
  expect((await s.sync()).status).toBe('blocked_by_failures');
  const [failed] = await s.failedRequests();
  await engine.executeRaw('UPDATE persistence_requests SET error_message=$2,error_detail=NULL WHERE request_id=$1::uuid',
    [failed!.request_id, "A takes fence row number is already used by a different take that is not in this page's canonical fence."]);
  await engine.unsetConfig('sync.holds');
  const converted = await s.sync();
  expect(converted).toMatchObject({ status: 'synced', held_count: 1, converted_from_failed: [failed!.request_id] });
  // The legacy message named no section; it comes from the refused bytes.
  expect(converted.held![0]).toMatchObject({ code: 'invalid_fence', reason: 'prepare_time', fence: { reason: 'stored_row_collision', fence: 'takes', section: 'body' } });

  // Compacted (message dropped, no detail): the re-screen of malformed bytes holds them...
  await engine.setConfig('sync.holds', 'fail');
  const t = await source(engine, { 'people/malformed.md': MALFORMED });
  expect((await t.sync()).status).toBe('blocked_by_failures');
  const [compacted] = await t.failedRequests();
  await engine.executeRaw('UPDATE persistence_requests SET error_message=NULL,error_detail=NULL,compacted=true WHERE request_id=$1::uuid', [compacted!.request_id]);
  await engine.unsetConfig('sync.holds');
  expect(await t.sync()).toMatchObject({ status: 'first_sync', held_count: 1, converted_from_failed: [compacted!.request_id] });

  // ...but an arbitrary invalid_params receipt, compacted or not, is never a fence hold: the cursor stays blocked.
  await engine.setConfig('sync.holds', 'fail');
  const u = await source(engine, { 'notes/ok.md': note('Ok') });
  u.write('notes/draft.md', MALFORMED);
  expect((await u.sync({ workingTree: true })).status).toBe('blocked_by_failures');
  const [arbitrary] = await u.failedRequests();
  await engine.executeRaw("UPDATE persistence_requests SET error_message='The value is invalid.',error_detail=NULL WHERE request_id=$1::uuid", [arbitrary!.request_id]);
  await engine.unsetConfig('sync.holds');
  u.write('notes/draft.md', note('Now clean'));
  expect((await u.sync({ workingTree: true })).status).toBe('blocked_by_failures');
  await engine.executeRaw('UPDATE persistence_requests SET error_message=NULL,compacted=true WHERE request_id=$1::uuid', [arbitrary!.request_id]);
  expect((await u.sync({ workingTree: true })).status).toBe('blocked_by_failures');
  expect(await u.holds()).toEqual([]);
}), 240_000);

test('dry run lists the fence hold a real run would write and writes nothing', () => each(async engine => {
  const s = await source(engine, { 'people/malformed.md': MALFORMED, 'notes/ok.md': note('Ok') });
  const dry = await s.sync({ dryRun: true });
  expect(dry).toMatchObject({ status: 'dry_run', would_hold_count: 1 });
  expect(dry.would_hold![0]).toMatchObject({ path: 'people/malformed.md', code: 'invalid_fence', fence: { fence: 'takes', section: 'body' } });
  expectNoSecrets(JSON.stringify(dry));
  expect(await s.holds()).toEqual([]);
  expect(await engine.getPage('notes/ok', { sourceId: s.id })).toBeNull();
}), 180_000);

test('a bulk group whose middle member fails on a stored-row collision is held and the rest of the group commits in one invocation', () => each(async engine => {
  if (engine.kind !== 'postgres') return;
  const files: Record<string, string> = { 'people/probe.md': takesPage('Probe', take(1)) };
  const s = await source(engine, files);
  await s.sync();
  await s.storedTake('people/probe', 2, 'Database-only take');
  // Manifest order puts the colliding page between three files before it and three after it.
  for (let i = 0; i < 3; i++) { s.write(`notes/n${i}.md`, note(`N${i}`)); s.write(`zz/z${i}.md`, note(`Z${i}`)); }
  s.write('people/probe.md', takesPage('Probe', take(1), take(2, 'Incoming take')));
  const head = commit(s.root, 'a group with one colliding member');
  const result = await s.sync({ bulk: { enabled: true, reason: null, size: 8, maxTxnMs: 15_000 } });
  expect(result).toMatchObject({ status: 'synced', added: 6, held_count: 1 });
  expect(result.held![0]).toMatchObject({ path: 'people/probe.md', reason: 'prepare_time' });
  expect(await s.lastCommit()).toBe(head);
  expect(await s.ledger()).toEqual([]);
  // The colliding page was admitted as a member of a bulk group, not on the single path.
  const [grouped] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND intent->>'path'='people/probe.md' AND intent ? 'group'", [s.id]);
  expect(grouped!.n).toBeGreaterThan(0);
}), 180_000);

// ── #6188 PR2: Tier 1 normalizes a fixable fence inline; the managed sync commits the rewritten file ──

const FB = '<!--- gbrain:facts:begin -->', FBE = '<!--- gbrain:facts:end -->';
const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|';
const FIXCLAIM = 'Sentinelfixzq8 partners with an example vendor';
const fixable = (title = 'Fixable') => `---\ntitle: ${title}\n---\nA synthetic page.\n\n${FB}\n${FH}\n| 1 | ${FIXCLAIM} | partnership | 1.0 | private | medium | 2026-01-01 |  | chat |  |\n${FBE}\n\n`
  + `${T}\n${TH}\n${take(1, 'Synthetic take', 'System')}\n${TE}\n`;
const committedBytes = (root: string, path: string) => git(root, 'show', `HEAD:${path}`);

test('a manifest with one fixable fence, one unfixable fence and clean files: the fixable file is rewritten, committed and imported; the other held', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': note('A'), 'notes/b.md': note('B'), 'people/fixable.md': fixable(), 'people/malformed.md': MALFORMED }, {}, true);
  const head = git(s.root, 'rev-parse', 'HEAD');
  const result = await s.sync();
  expect(result).toMatchObject({ status: 'first_sync', added: 3, held_count: 1 });
  expect(await s.lastCommit()).toBe(head);
  expect(result.held!.map(item => item.path)).toEqual(['people/malformed.md']);
  expect(result.fences_normalized).toMatchObject({ count: 1, by_class: { kind_map: 1, holder_alias: 1 }, sample_paths: ['people/fixable.md'],
    common_prefix: 'people', writers: [{ writer: 'people/', count: 1 }] });
  // The stored page and its projections are the normalized fence: the invented kind maps to fact (word kept in context), system -> brain.
  const page = await engine.getPage('people/fixable', { sourceId: s.id });
  const [fact] = parseFactsFence(page!.compiled_truth).facts;
  expect(fact).toMatchObject({ rowNum: 1, claim: FIXCLAIM, kind: 'fact', context: 'original kind: partnership' });
  expect(parseTakesFence(page!.compiled_truth).takes[0]).toMatchObject({ rowNum: 1, holder: 'brain' });
  expect(await engine.executeRaw('SELECT kind FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num=1', [s.id, 'people/fixable'])).toEqual([{ kind: 'fact' }]);
  expect(await engine.executeRaw('SELECT holder FROM takes k JOIN pages p ON p.id=k.page_id WHERE p.source_id=$1 AND p.slug=$2', [s.id, 'people/fixable'])).toEqual([{ holder: 'brain' }]);
  // The file is rewritten on disk and the Git effect commits it (claims unchanged).
  await waitFor(() => { try { return committedBytes(s.root, 'people/fixable.md').includes('| fact |'); } catch { return false; } }, { timeoutMs: 30_000, label: 'normalized file committed' });
  const onDisk = readFileSync(join(s.root, 'people/fixable.md'), 'utf8');
  expect(onDisk).toContain(FIXCLAIM);
  expect(parseFactsFence(onDisk).warnings).toEqual([]);
  expect(parseTakesFence(onDisk).takes[0]!.holder).toBe('brain');
  expect(committedBytes(s.root, 'people/fixable.md')).toBe(onDisk.trim());
  expect(git(s.root, 'status', '--porcelain', '--', 'people')).toBe('');
  expect(git(s.root, 'log', '-1', '--format=%s')).toBe('gbrain: persist canonical memory update');
  // Printed output names the normalization and the writer advice; never a claim, holder or kind value.
  const text = printed(result);
  expect(text).toContain('Normalized fences in 1 file(s) (kind_map x1, holder_alias x1).');
  for (const blob of [JSON.stringify(result), text]) { expectNoSecrets(blob); expect(blob).not.toContain('Sentinelfixzq8'); expect(blob).not.toContain('partnership'); }
  const receipts = await engine.executeRaw<{ outcome: unknown }>("SELECT outcome FROM persistence_requests WHERE source_id=$1 AND state='committed'", [s.id]);
  for (const blob of [JSON.stringify(receipts)]) { expect(blob).not.toContain('Sentinelfixzq8'); expect(blob).not.toContain('partnership'); }
  // Fixed point: the next sync reads gbrain's own commit as a no-op and normalizes nothing; the one after is up to date.
  const again = await s.sync();
  expect(again).toMatchObject({ added: 0, modified: 0 });
  expect(again.fences_normalized).toBeUndefined();
  expect((await s.sync()).status).toBe('up_to_date');
}), 180_000);

test('dry run lists the file it would normalize beside the hold and leaves every file byte-identical', () => each(async engine => {
  const s = await source(engine, { 'people/fixable.md': fixable(), 'people/malformed.md': MALFORMED, 'notes/ok.md': note('Ok') });
  const before = readFileSync(join(s.root, 'people/fixable.md'), 'utf8');
  const dry = await s.sync({ dryRun: true });
  expect(dry).toMatchObject({ status: 'dry_run', would_hold_count: 1, would_normalize_count: 1 });
  expect(dry.would_normalize).toEqual([{ path: 'people/fixable.md', classes: ['kind_map', 'holder_alias'] }]);
  expect(printed(dry)).toContain('Would normalize people/fixable.md: kind_map, holder_alias');
  expect(readFileSync(join(s.root, 'people/fixable.md'), 'utf8')).toBe(before);
  expect(git(s.root, 'status', '--porcelain', '--', 'people')).toBe('');
  expect(await engine.getPage('people/fixable', { sourceId: s.id })).toBeNull();
  for (const blob of [JSON.stringify(dry), printed(dry)]) { expectNoSecrets(blob); expect(blob).not.toContain('Sentinelfixzq8'); }
}), 180_000);

test('fences.normalize=false: the fixable file is held like any malformed fence and nothing is rewritten', () => each(async engine => {
  await engine.setConfig('fences.normalize', 'false');
  const s = await source(engine, { 'people/fixable.md': fixable(), 'notes/ok.md': note('Ok') });
  const before = readFileSync(join(s.root, 'people/fixable.md'), 'utf8');
  const result = await s.sync();
  expect(result).toMatchObject({ status: 'first_sync', added: 1, held_count: 1 });
  expect(result.fences_normalized).toBeUndefined();
  expect(result.held![0]).toMatchObject({ path: 'people/fixable.md', code: 'invalid_fence', fence: { fence: 'facts', section: 'body' } });
  expect(readFileSync(join(s.root, 'people/fixable.md'), 'utf8')).toBe(before);
  expect(await engine.getPage('people/fixable', { sourceId: s.id })).toBeNull();
  // A hold an older screen wrote (v0.60.98.0's fence_version 1, before Tier 1 existed) re-screens on the
  // next sync with no command once normalization is on: the file is normalized, committed and imported.
  await engine.unsetConfig('fences.normalize');
  await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,meta,fence_version}','1'::jsonb) WHERE op='sync-hold' AND fingerprint LIKE $1`, [`${s.id}:%`]);
  const after = await s.sync();
  expect(after.fences_normalized).toMatchObject({ count: 1 });
  expect(await s.holds()).toEqual([]);
  expect(parseFactsFence((await engine.getPage('people/fixable', { sourceId: s.id }))!.compiled_truth).facts[0]!.kind).toBe('fact');
}), 180_000);

test('a read-only mirror keeps the normalized fence in the database only; its checkout stays the remote bytes', () => each(async engine => {
  const s = await source(engine, { 'people/fixable.md': fixable() }, { mirror_read_only: 'true' });
  const before = readFileSync(join(s.root, 'people/fixable.md'), 'utf8');
  const result = await s.sync();
  expect(result).toMatchObject({ added: 1, fences_normalized: { count: 1 } });
  expect(parseFactsFence((await engine.getPage('people/fixable', { sourceId: s.id }))!.compiled_truth).facts[0]!.kind).toBe('fact');
  expect(readFileSync(join(s.root, 'people/fixable.md'), 'utf8')).toBe(before);
  expect(git(s.root, 'status', '--porcelain', '--', 'people')).toBe('');
}), 180_000);

test('TE1: a stored take whose prior fence did not parse is updated by its normalized row, not refused as a collision', () => each(async engine => {
  const s = await source(engine, { 'people/probe.md': takesPage('Probe', take(1)) });
  await s.sync();
  // The stored page's fence later stopped parsing (an older writer used the invented kind `assessment`, which the
  // strict parser drops), while the takes table still holds that row.
  const bad = takesPage('Probe', take(1), take(2, 'Second take', 'brain', 'assessment'));
  await engine.transaction(tx => withCoordinatedWrite(tx, [s.id], async () => {
    await tx.executeRaw("UPDATE pages SET compiled_truth=$3 WHERE source_id=$1 AND slug=$2", [s.id, 'people/probe', bad.split('---\n').slice(2).join('---\n')]);
    await tx.executeRaw("INSERT INTO takes(page_id,row_num,claim,kind,holder,weight) SELECT id,2,'Second take','assessment','brain',0.7 FROM pages WHERE source_id=$1 AND slug=$2", [s.id, 'people/probe']);
  }, TEST_WRITE_ATTRIBUTION));
  s.write('people/probe.md', bad); commit(s.root, 'invented kind');
  const result = await s.sync();
  expect(result).toMatchObject({ status: 'synced', fences_normalized: { count: 1, by_class: { kind_map: 1 } } });
  expect(result.held_count ?? 0).toBe(0);
  expect(await engine.executeRaw('SELECT row_num,kind FROM takes k JOIN pages p ON p.id=k.page_id WHERE p.source_id=$1 AND p.slug=$2 ORDER BY row_num', [s.id, 'people/probe']))
    .toEqual([{ row_num: 1, kind: 'take' }, { row_num: 2, kind: 'take' }]);
}), 180_000);

test('E33: a sync that normalizes 50 files writes one trend row with the run total; the census lists the held file once', () => each(async engine => {
  const files: Record<string, string> = { 'people/malformed.md': MALFORMED };
  for (let i = 0; i < 50; i++) files[`notes/fix-${String(i).padStart(2, '0')}.md`] = fixable(`Fix ${i}`);
  const s = await source(engine, files);
  const result = await s.sync();
  expect(result).toMatchObject({ held_count: 1, fences_normalized: { count: 50 } });
  const trend = await engine.executeRaw<{ record: Record<string, unknown> }>(`SELECT completed_keys->0 AS record FROM op_checkpoints WHERE op=$1 AND completed_keys->0->>'source_id'=$2`,
    [FENCE_TREND_OP, s.id]);
  expect(trend).toHaveLength(1);
  expect(trend[0]!.record).toMatchObject({ count: 50, by_class: { kind_map: 50, holder_alias: 50 }, writers: { 'notes/': 50 } });
  // A second sync with nothing new adds no trend row.
  await s.sync();
  expect(await engine.executeRaw(`SELECT 1 FROM op_checkpoints WHERE op=$1 AND completed_keys->0->>'source_id'=$2`, [FENCE_TREND_OP, s.id])).toHaveLength(1);
  await runFenceCensus(engine, { sourceIds: [s.id], deadline: Date.now() + 60_000 });
  const candidates = await listFenceCandidates(engine, [s.id]);
  expect(candidates.map(c => [c.key, c.bucket, c.origins, c.tier, c.reasons])).toEqual([['people/malformed', 'hold', ['hold', 'file'], 'resolver', ['holder_unresolved']]]);
  expectNoSecrets(JSON.stringify(candidates));
}), 240_000);

test('E33: a completed sync run always has its trend row; a failed trend write fails the cursor step that counts it instead of vanishing', () => each(async engine => {
  const s = await source(engine, { 'notes/fix-a.md': fixable('A'), 'notes/fix-b.md': fixable('B'), 'notes/plain.md': note('Plain') });
  const rows = () => engine.executeRaw<{ record: Record<string, unknown> }>(`SELECT completed_keys->0 AS record FROM op_checkpoints WHERE op=$1 AND completed_keys->0->>'source_id'=$2`,
    [FENCE_TREND_OP, s.id]);
  // Forced fault: the first trend INSERT fails, wherever it runs (the run's own statement or inside a publication transaction).
  const original = engine.executeRaw;
  let injected = 0;
  (engine as unknown as { executeRaw: typeof original }).executeRaw = function (this: typeof engine, sql: string, params?: unknown[]) {
    if (!injected && params?.[0] === FENCE_TREND_OP && sql.includes('INSERT INTO op_checkpoints')) { injected++; return Promise.reject(new Error('injected trend write failure')); }
    return original.call(this, sql, params) as never;
  } as typeof original;
  let first: SyncResult | null = null;
  try { first = await s.sync(); } catch { /* the cursor step that carried the failed trend write failed with it */ } finally {
    (engine as unknown as { executeRaw: typeof original }).executeRaw = original;
  }
  expect(injected).toBe(1);
  // A run reported complete has its trend row; a run whose trend could not be written did not complete.
  const complete = (result: SyncResult | null) => result?.status === 'first_sync' || result?.status === 'synced';
  if (complete(first)) expect(await rows()).toHaveLength(1);
  // The next sync resumes the same run from its cursor and records the run's whole total once.
  const settled = complete(first) ? first! : await s.sync();
  expect(complete(settled)).toBe(true);
  const recorded = await rows();
  expect(recorded).toHaveLength(1);
  expect(recorded[0]!.record).toMatchObject({ count: 2, by_class: { kind_map: 2, holder_alias: 2 } });
}), 180_000);
