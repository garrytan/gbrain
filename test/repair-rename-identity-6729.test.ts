/**
 * #6729 remedy: `gbrain repair rename-identity`, the deferred true rename for an inexact Git rename that sync split into a
 * delete plus an add. The operator names the pair (--slug, --from); the preview binds both page ids, both revisions and
 * the disposition into its hash; the apply (destructive consent) carries the old page id onto the new slug with its
 * version history, timeline, links and facts, imports the new file onto it as an edit and retires the provisional page,
 * or (--close) releases the purge hold and moves nothing. Facts of both pages survive or the carry refuses
 * fact_rows_collide before anything is written. Carry is classic-only: on a managed source the preview, apply and every
 * surface name managed_remedy_unavailable and --close.
 * Explicit-only: --all, the maintenance cycle and the remediation plan never run it. Modules are imported lazily so this
 * file loads (and fails by behavior) on a tree without the kind.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { renderFactsTable, type ParsedFact } from '../src/core/facts-fence.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const write = (root: string, path: string, body: string) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), body); };
const BODY = Array.from({ length: 30 }, (_, i) => `- Shared meeting ${i}: discussed the project roadmap, hiring and next steps.`).join('\n');
const fence = (rows: Array<[number, string]>) => rows.length ? `\n## Facts\n\n${renderFactsTable(rows.map(([rowNum, claim]): ParsedFact => ({ rowNum, claim, kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', active: true })))}\n` : '';
const doc = (rows: Array<[number, string]>, tail = '') => `---\ntype: note\n---\n\n${BODY}\n${tail}${fence(rows)}`;
const quiet = { info() {}, warn() {}, error() {} };

async function capture(fn: () => Promise<void>): Promise<string> {
  let printed = '';
  const original = console.log, write = process.stdout.write;
  console.log = (...parts: unknown[]) => { printed += `${parts.map(String).join(' ')}\n`; };
  process.stdout.write = ((chunk: string | Uint8Array) => { printed += String(chunk); return true; }) as typeof process.stdout.write;
  try { await fn(); } finally { console.log = original; process.stdout.write = write; }
  return printed;
}
async function refusal(run: () => Promise<unknown>): Promise<OperationError> {
  try { await run(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

for (const kind of testBackends()) describe(`gbrain repair rename-identity (#6729, ${kind})`, () => {
  let engine: BrainEngine, close: (() => Promise<void>) | undefined;
  const home = mkdtempSync(join(tmpdir(), 'gbrain-6729-remedy-'));
  const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_INTERACTIVE: '0', CI: '1' };
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
  }, 120_000);
  afterAll(async () => {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1').catch(() => undefined);
    if (close) await close(); else await engine.disconnect();
    rmSync(home, { recursive: true, force: true });
  });
  beforeEach(() => _resetCliExitVerdictForTests());

  /** Whether a classic fixture source admits a restore: PGLite does; an unbound Postgres source with a checkout does not. */
  const restoreOffered = kind === 'pglite';
  const repair = async (args: string[]) => {
    const { runRepairCommand } = await import('../src/commands/repair.ts');
    return capture(() => runRepairCommand(engine, args));
  };
  const repairJson = async (args: string[]) => JSON.parse(await repair([...args, '--json'])).results[0];

  /** A classic source whose notes/plan.md moves to notes/roadmap.md with an edit and no identity signal: a recorded downgrade. */
  async function classicDowngrade(oldFence: Array<[number, string]>, newFence: Array<[number, string]> = oldFence) {
    const id = `c${randomUUID().replace(/-/g, '').slice(0, 14)}`, root = join(home, id);
    mkdirSync(root, { recursive: true }); git(root, 'init', '-q', '-b', 'main');
    write(root, 'notes/plan.md', doc(oldFence)); write(root, 'notes/peer.md', '---\ntype: note\ntitle: Peer\n---\n\nA different page.\n');
    commit(root, 'initial');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
    const sync = () => performSync(engine, { repoPath: root, sourceId: id, noPull: true, noEmbed: true, noExtract: true, concurrency: 1 });
    await sync();
    const old = (await page(id, 'notes/plan'))!;
    for (const [row, claim] of oldFence) await fenceFact(id, 'notes/plan', row, claim);
    git(root, 'mv', 'notes/plan.md', 'notes/roadmap.md'); write(root, 'notes/roadmap.md', doc(newFence, 'An added paragraph.\n'));
    commit(root, 'move and edit');
    const result = await sync();
    expect(result.identityDowngrades?.map(entry => [entry.from, entry.to, entry.reason])).toEqual([['notes/plan.md', 'notes/roadmap.md', 'no_identity_signal']]);
    const fresh = (await page(id, 'notes/roadmap'))!;
    for (const [row, claim] of newFence) await fenceFact(id, 'notes/roadmap', row, claim);
    return { id, root, sync, old, fresh, result };
  }
  const page = async (sourceId: string, slug: string) => (await engine.executeRaw<{ id: number; slug: string; deleted_at: string | null; compiled_truth: string; source_path: string | null }>(
    'SELECT id, slug, deleted_at, compiled_truth, source_path FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0];
  const pageById = async (id: number) => (await engine.executeRaw<{ slug: string; deleted_at: string | null }>('SELECT slug, deleted_at FROM pages WHERE id=$1', [id]))[0];
  const fenceFact = async (sourceId: string, slug: string, row: number, claim: string) => {
    await engine.insertFacts([{ fact: claim, kind: 'fact', visibility: 'world', notability: 'medium', source: 'fence:reconcile', entity_slug: slug, row_num: row, source_markdown_slug: slug }], { source_id: sourceId });
  };
  const facts = (sourceId: string) => engine.executeRaw<{ id: number; fact: string; entity_slug: string; source_markdown_slug: string | null; row_num: number | null; created_at: string; valid_from: string }>(
    'SELECT id, fact, entity_slug, source_markdown_slug, row_num, created_at::text, valid_from::text FROM facts WHERE source_id=$1 ORDER BY fact', [sourceId]);
  const versions = async (pageId: number) => Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_versions WHERE page_id=$1', [pageId]))[0]!.n);
  const disposition = async (oldPageId: number) => (await engine.executeRaw<{ d: unknown }>("SELECT completed_keys->0->'disposition' AS d FROM op_checkpoints WHERE op='sync-identity-downgrade' AND fingerprint=$1", [String(oldPageId)]))
    .map(row => typeof row.d === 'string' ? JSON.parse(row.d) : row.d)[0];
  const openRecords = async (sourceId: string) => (await import('../src/core/sync-identity-downgrades.ts')).listIdentityDowngrades(engine, [sourceId]);

  test('carry: the old page id takes the new slug with its history, timeline, links and facts; the new file is an edit; the provisional page is retired; a rerun refuses cleanly', () => withEnv(env, async () => {
    const s = await classicDowngrade([[1, 'Alpha ships payments']]);
    const peer = (await page(s.id, 'notes/peer'))!;
    // Identity the old page holds: a version, a timeline entry, a link, an unfenced fact known since January.
    await engine.executeRaw("INSERT INTO page_versions(page_id, compiled_truth, frontmatter) VALUES($1, 'an earlier body', '{}')", [s.old.id]);
    await engine.executeRaw("INSERT INTO timeline_entries(page_id, date, source, summary) VALUES($1, '2026-01-05', 'test', 'Planning kickoff')", [s.old.id]);
    await engine.executeRaw("INSERT INTO links(from_page_id,to_page_id,link_type,link_source) VALUES($1,$2,'mentions','test')", [s.old.id, peer.id]);
    await engine.insertFact({ fact: 'Plan is owned by the platform team', entity_slug: 'notes/plan', visibility: 'world', source: 'synthetic' }, { source_id: s.id });
    await engine.executeRaw("UPDATE facts SET created_at='2026-01-02T00:00:00Z', valid_from='2026-01-02T00:00:00Z' WHERE source_id=$1 AND source_markdown_slug IS DISTINCT FROM 'notes/roadmap'", [s.id]);
    const knownBefore = Object.fromEntries((await facts(s.id)).filter(f => f.entity_slug === 'notes/plan').map(f => [f.fact, { id: f.id, created_at: f.created_at, valid_from: f.valid_from }]));
    // The destination is edited after the split: a second fence row and a new paragraph, then a fact on the provisional page.
    write(s.root, 'notes/roadmap.md', doc([[1, 'Alpha ships payments'], [2, 'Beta ships search']], 'An added paragraph.\nEdited after the split.\n'));
    commit(s.root, 'edit the destination');
    await s.sync();
    await fenceFact(s.id, 'notes/roadmap', 2, 'Beta ships search');
    await engine.insertFact({ fact: 'Roadmap is reviewed weekly', entity_slug: 'notes/roadmap', visibility: 'world', source: 'synthetic' }, { source_id: s.id });
    const oldVersions = await versions(s.old.id), provisionalVersions = await versions(s.fresh.id);
    expect((await page(s.id, 'notes/roadmap'))!.id).toBe(s.fresh.id);

    const preview = await repairJson(['rename-identity', '--source', s.id, '--slug', 'notes/roadmap']);
    expect(structuredClone(preview)).toMatchObject({ kind: 'rename-identity', mode: 'dry_run', affected: 1, preview_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      details: { disposition: 'carry', old: { page_id: s.old.id, slug: 'notes/plan', deleted: true }, new: { page_id: s.fresh.id, slug: 'notes/roadmap', deleted: false } } });
    expect(preview.apply_command).toBe(`gbrain repair rename-identity --source ${s.id} --slug notes/roadmap --apply --expect ${preview.preview_hash} --yes`);
    const [record] = await openRecords(s.id);
    const { identityRemedy } = await import('../src/core/sync-identity-downgrades.ts');
    expect((await identityRemedy(engine, record!)).plan_hash).toBe(preview.preview_hash);

    const applied = await repairJson(['rename-identity', '--source', s.id, '--slug', 'notes/roadmap', '--apply', '--expect', preview.preview_hash, '--yes']);
    expect(applied).toMatchObject({ mode: 'apply', applied: 1, failed: [], complete: true, outcomes: { carried: 1 } });
    const carried = (await page(s.id, 'notes/roadmap'))!;
    expect(carried).toMatchObject({ id: s.old.id, deleted_at: null, source_path: 'notes/roadmap.md' });
    expect(carried.compiled_truth).toContain('Edited after the split.');
    expect(await page(s.id, 'notes/plan')).toBeUndefined();
    expect(await engine.executeRaw('SELECT alias_slug, canonical_slug FROM slug_aliases WHERE source_id=$1', [s.id])).toEqual([{ alias_slug: 'notes/plan', canonical_slug: 'notes/roadmap' }]);
    expect(await pageById(s.fresh.id)).toMatchObject({ slug: `notes/roadmap~purged-${s.fresh.id}`, deleted_at: expect.anything() });
    // History: the old versions, the provisional's versions, the rename's preimage (updateSlug versions the page as it
    // stood, for belief page-at-time) and the import's snapshot of the old body (the new file is the page now).
    const carriedVersions = oldVersions + provisionalVersions + 2;
    expect(await versions(s.old.id)).toBe(carriedVersions);
    expect(await versions(s.fresh.id)).toBe(0);
    expect(await engine.executeRaw('SELECT summary FROM timeline_entries WHERE page_id=$1', [s.old.id])).toEqual([{ summary: 'Planning kickoff' }]);
    expect((await engine.executeRaw<{ to_page_id: number }>('SELECT to_page_id FROM links WHERE from_page_id=$1', [s.old.id])).map(l => Number(l.to_page_id))).toContain(peer.id);
    const after = await facts(s.id);
    expect(after.map(f => [f.fact, f.entity_slug, f.source_markdown_slug, f.row_num])).toEqual([
      ['Alpha ships payments', 'notes/roadmap', 'notes/roadmap', 1], ['Beta ships search', 'notes/roadmap', 'notes/roadmap', 2],
      ['Plan is owned by the platform team', 'notes/roadmap', null, null], ['Roadmap is reviewed weekly', 'notes/roadmap', null, null]]);
    // known_as_of: the carried rows keep their id, created_at and valid_from.
    for (const fact of ['Alpha ships payments', 'Plan is owned by the platform team']) {
      expect(after.find(f => f.fact === fact)).toMatchObject(knownBefore[fact]!);
    }
    expect(await openRecords(s.id)).toEqual([]);
    expect(await disposition(s.old.id)).toEqual({ kind: 'remedied', at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });

    // Idempotent: the same apply, and a new preview, find no open pair and refuse; nothing is duplicated.
    for (const rerun of [['--apply', '--expect', preview.preview_hash, '--yes'], []]) {
      const again = await refusal(() => repair(['rename-identity', '--source', s.id, '--slug', 'notes/roadmap', ...rerun]));
      expect(again.code).toBe('invalid_params');
      expect(again.message).toContain('has no open rename-identity pair with new page notes/roadmap');
      expect(again.suggestion).toContain('already carried or closed');
    }
    expect(await facts(s.id)).toEqual(after);
    expect(await versions(s.old.id)).toBe(carriedVersions);
    // The next sync keeps the carried page.
    await s.sync();
    expect((await page(s.id, 'notes/roadmap'))!.id).toBe(s.old.id);
  }), 240_000);

  test('different claims at one fence row number refuse fact_rows_collide before anything is written, naming the rows; so does an old row the new file dropped', () => withEnv(env, async () => {
    for (const newFence of [[[1, 'Gamma ships billing']], []] as Array<Array<[number, string]>>) {
      const s = await classicDowngrade([[1, 'Alpha ships payments']], newFence);
      const before = await facts(s.id);
      const error = await refusal(() => repair(['rename-identity', '--source', s.id, '--slug', 'notes/roadmap']));
      expect(error.code).toBe('fact_rows_collide');
      expect(error.message).toContain('row 1');
      expect(error.message).toContain('Alpha ships payments');
      expect(error.suggestion).toContain('--close');
      expect(await facts(s.id)).toEqual(before);
      expect((await page(s.id, 'notes/roadmap'))!.id).toBe(s.fresh.id);
      expect((await page(s.id, 'notes/plan'))!.deleted_at).not.toBeNull();
      expect((await openRecords(s.id)).length).toBe(1);
    }
  }), 240_000);

  test('--close releases the purge hold and moves nothing; the purge then takes the old page', () => withEnv(env, async () => {
    const s = await classicDowngrade([]);
    expect((await purgeDeletedPagesCoordinated(engine, 0)).slugs).not.toContain('notes/plan');
    const preview = await repairJson(['rename-identity', '--source', s.id, '--slug', 'notes/roadmap', '--close']);
    expect(preview.apply_command).toBe(`gbrain repair rename-identity --source ${s.id} --slug notes/roadmap --close --apply --expect ${preview.preview_hash} --yes`);
    const carryHash = (await repairJson(['rename-identity', '--source', s.id, '--slug', 'notes/roadmap'])).preview_hash;
    expect(carryHash).not.toBe(preview.preview_hash);
    const applied = await repairJson(['rename-identity', '--source', s.id, '--slug', 'notes/roadmap', '--close', '--apply', '--expect', preview.preview_hash, '--yes']);
    expect(applied).toMatchObject({ applied: 1, outcomes: { closed: 1 } });
    expect(await disposition(s.old.id)).toEqual({ kind: 'closed', at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });
    expect((await page(s.id, 'notes/roadmap'))!.id).toBe(s.fresh.id);
    expect(await pageById(s.old.id)).toMatchObject({ slug: 'notes/plan', deleted_at: expect.anything() });
    expect(await openRecords(s.id)).toEqual([]);
    expect((await purgeDeletedPagesCoordinated(engine, 0)).slugs).toContain('notes/plan');
    expect(await pageById(s.old.id)).toBeUndefined();
  }), 240_000);

  test('without --slug the preview lists each open pair with its preview command and nothing can be applied; --apply without a pair refuses', () => withEnv(env, async () => {
    const s = await classicDowngrade([]);
    const listed = await repairJson(['rename-identity', '--source', s.id]);
    expect(listed).toMatchObject({ affected: 0, residuals: { open_pairs: 1 } });
    expect(listed.preview_hash).toBeUndefined();
    expect(listed.listing).toEqual([{ item: `${s.id}:notes/plan -> notes/roadmap`, class: 'no_identity_signal',
      detail: expect.stringContaining(`preview: gbrain repair rename-identity --source ${s.id} --slug notes/roadmap;`) }]);
    expect((await refusal(() => repair(['rename-identity', '--source', s.id, '--apply', '--yes']))).code).toBe('invalid_params');
    expect((await refusal(() => repair(['rename-identity', '--slug', 'notes/roadmap']))).code).toBe('invalid_params');
  }), 240_000);

  test('without --yes a non-interactive apply exits 3 with the destructive consent payload and changes nothing', () => withEnv(env, async () => {
    const s = await classicDowngrade([]);
    const preview = await repairJson(['rename-identity', '--source', s.id, '--slug', 'notes/roadmap']);
    const priorExitCode = process.exitCode;
    const out = await repair(['rename-identity', '--source', s.id, '--slug', 'notes/roadmap', '--apply', '--expect', preview.preview_hash, '--json']);
    expect(currentExitCode()).toBe(3);
    process.exitCode = priorExitCode ?? 0;
    const payload = JSON.parse(out);
    expect(JSON.stringify(payload)).toContain('destructive');
    expect(JSON.stringify(payload)).toContain('user_message');
    expect(JSON.stringify(payload)).toContain(`--slug notes/roadmap --apply --expect ${preview.preview_hash}`);
    expect((await page(s.id, 'notes/roadmap'))!.id).toBe(s.fresh.id);
    expect((await openRecords(s.id)).length).toBe(1);
  }), 240_000);

  test('doctor names the remedy: render the envelope, run preview_argv, run argv with the hash (consent given), then verify clears the finding', () => withEnv(env, async () => {
    const s = await classicDowngrade([]);
    const { renameIdentityDowngradesEntry } = await import('../src/commands/doctor/checks/rename-identity-downgrades.ts');
    const doctor = async () => (await renameIdentityDowngradesEntry.run({ engine } as unknown as DoctorContext)) as unknown as Array<{ status: string; message: string;
      details: { by_source: Array<{ source_id: string; count: number }>; samples: Array<{ source_id: string; remedy: Record<string, unknown> }> }; fix?: Record<string, unknown> & { argv: string[]; preview_argv: string[]; plan_hash: string; verify: { argv: string[] } } }>;
    const mine = (finding: Awaited<ReturnType<typeof doctor>>[number]) => finding.details.by_source.find(entry => entry.source_id === s.id)?.count ?? 0;
    // Only this source's pair is open, so the first pair is ours.
    await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='sync-identity-downgrade' AND completed_keys->0->>'source_id' <> $1", [s.id]);
    const [finding] = await doctor();
    expect(finding!.status).toBe('warn');
    const preview = ['gbrain', 'repair', 'rename-identity', '--source', s.id, '--slug', 'notes/roadmap'];
    expect(structuredClone(finding!.fix)).toMatchObject({ argv: [...preview, '--apply', '--expect', expect.stringMatching(/^[0-9a-f]{64}$/), '--yes'], preview_argv: preview, consent: ['destructive'],
      actor: 'agent', ask_user: true, user_message: expect.stringContaining('notes/plan'), verify: { argv: ['gbrain', 'doctor', '--only', 'rename_identity_downgrades', '--json'] } });
    // An unbound classic Postgres source refuses a restore (owner_unavailable), so only PGLite names the alternative.
    if (restoreOffered) {
      expect(finding!.fix!.why).toContain(`gbrain restore notes/plan --source-id ${s.id} --force`);
      expect(finding!.message).toContain(`gbrain restore notes/plan --source-id ${s.id} --force`);
    } else {
      for (const said of [finding!.fix!.why, finding!.message, String(finding!.fix!.user_message)]) expect(said).not.toContain('gbrain restore');
      expect((finding!.details as unknown as { restore_unavailable_sources: string[] }).restore_unavailable_sources).toContain(s.id);
    }
    expect(structuredClone(finding!.details.samples[0]!.remedy)).toMatchObject({ plan_hash: finding!.fix!.plan_hash, consent: ['destructive'], hold_releases: 'the remedy carries or closes the pair, or the old page is restored or purged' });
    const { deriveNext, renderAction } = await import('../src/core/agent-output.ts');
    const ctx = { transport: 'cli' as const, isCallable: () => false, preapproved: () => true };
    expect(deriveNext(finding!.fix as never, ctx)).toBe('ask_user');
    expect(renderAction(finding!.fix as never, ctx)).toMatchObject({ next: 'ask_user', preview_argv: preview, plan_hash: finding!.fix!.plan_hash });
    const previewed = await repairJson(finding!.fix!.preview_argv.slice(2));
    expect(previewed.preview_hash).toBe(finding!.fix!.plan_hash);
    const applied = await repairJson(finding!.fix!.argv.slice(2));
    expect(applied).toMatchObject({ applied: 1, outcomes: { carried: 1 } });
    const [verified] = await doctor();
    expect(finding!.fix!.verify.argv).toEqual(['gbrain', 'doctor', '--only', 'rename_identity_downgrades', '--json']);
    expect(mine(verified!)).toBe(0);
    expect((await page(s.id, 'notes/roadmap'))!.id).toBe(s.old.id);
  }), 240_000);

  test('the sync report and sync status name each pair with its preview, apply, consent and hold release', () => withEnv(env, async () => {
    const s = await classicDowngrade([]);
    const [entry] = s.result.identityDowngrades as unknown as Array<{ remedy: { preview_argv: string[]; argv: string[]; consent: string[]; hold_releases: string; plan_hash: string } }>;
    expect(entry!.remedy).toMatchObject({ preview_argv: ['gbrain', 'repair', 'rename-identity', '--source', s.id, '--slug', 'notes/roadmap'], consent: ['destructive'] });
    expect(entry!.remedy.argv.slice(-4)).toEqual(['--apply', '--expect', entry!.remedy.plan_hash, '--yes']);
    expect(entry!.remedy.hold_releases).toBe('the remedy carries or closes the pair, or the old page is restored or purged');
    const { identityDowngradeLines, withIdentityRemedies } = await import('../src/core/sync-identity-downgrades.ts');
    const text = identityDowngradeLines(await withIdentityRemedies(engine, await openRecords(s.id))).join('\n');
    expect(text).toContain(`preview gbrain repair rename-identity --source ${s.id} --slug notes/roadmap, then apply gbrain repair rename-identity --source ${s.id} --slug notes/roadmap --apply --expect ${entry!.remedy.plan_hash} --yes`);
    expect(text).toContain('asks the user first: destructive');
    if (restoreOffered) expect(text).toContain(`or keep notes/plan as its own page: gbrain restore notes/plan --source-id ${s.id} --force`);
    else expect(text).not.toContain('gbrain restore');
    expect(text).toContain('The purge holds notes/plan until the remedy carries or closes the pair, or the old page is restored or purged.');
    expect(text).not.toMatch(/72 h|72-hour|expires/);
  }), 240_000);

  test('--all, the maintenance cycle and the doctor remediation plan never run it', () => withEnv(env, async () => {
    const s = await classicDowngrade([]);
    // --all --apply runs every auto kind over the whole shared test brain; an unrelated kind that stops short (timeline on a
    // large Postgres brain) sets exit 1, which is not this test's subject, so the prior exit code is restored after it.
    const priorExitCode = process.exitCode;
    const allOut = await repair(['--all', '--apply', '--json']);
    process.exitCode = priorExitCode ?? 0;
    const all = JSON.parse(allOut) as { results: Array<{ kind: string }>; explicit_kinds: Array<{ kind: string; code: string; preview_command: string; docs: string }> };
    expect(all.results.map(r => r.kind)).not.toContain('rename-identity');
    expect(all.explicit_kinds).toContainEqual({ kind: 'rename-identity', code: 'explicit_kind_required', preview_command: 'gbrain repair rename-identity', docs: 'docs/guides/repair.md#explicit-only-repair-kinds' });
    const { computeRemediationPlan } = await import('../src/core/remediation/index.ts');
    const plan = await computeRemediationPlan(engine, { repairs: {} });
    expect(plan.repair_steps!.map(step => step.kind)).not.toContain('rename-identity');
    expect(plan.explicit_repairs!.map(n => [n.kind, n.code])).toContainEqual(['rename-identity', 'explicit_kind_required']);
    const { runRepairSteps } = await import('../src/core/remediation/repairs.ts');
    const supplied = await refusal(() => runRepairSteps(engine, [{ step: 1, id: 'repair:rename-identity', kind: 'rename-identity' as never, affected: 1, command: 'gbrain repair rename-identity --apply',
      requires_user_agreement: true, protected: true, paid: false, embeds: 'none', est_usd_cost: 0, lifetime_ids: 0, checks: [], rationale: 'supplied' }], { remote: false, remainingUsd: () => undefined }));
    expect(supplied.code).toBe('explicit_kind_required');
    const { contentRepairPhaseKinds, runContentRepairPhase } = await import('../src/core/cycle/content-repair.ts');
    expect(contentRepairPhaseKinds()).not.toContain('rename-identity' as never);
    await runContentRepairPhase(engine, { dryRun: false });
    const { repairRunner } = await import('../src/core/repair/registry.ts');
    const { resolveRepairScope } = await import('../src/core/repair/core.ts');
    const runner = await repairRunner(engine, { apply: true, logger: quiet });
    expect((await refusal(() => runner.run('rename-identity' as never, { brain_id: 'host', source_ids: [s.id] }))).code).toBe('explicit_kind_required');
    expect(await resolveRepairScope(engine, s.id)).toMatchObject({ source_ids: [s.id] });
    expect((await openRecords(s.id)).length).toBe(1);
    expect((await page(s.id, 'notes/roadmap'))!.id).toBe(s.fresh.id);
    expect((await page(s.id, 'notes/plan'))!.deleted_at).not.toBeNull();
  }), 240_000);

  test('managed: carrying is unavailable (managed_remedy_unavailable) on the preview, the apply, the report, status and doctor; --close settles the pair and the purge takes the old page; restore still keeps one', () => withEnv(env, async () => {
    const id = `m${randomUUID().replace(/-/g, '').slice(0, 14)}`, root = join(home, id);
    mkdirSync(root, { recursive: true }); git(root, 'init', '-q');
    write(root, 'notes/plan.md', doc([[1, 'Alpha ships payments']])); write(root, 'notes/other.md', doc([[1, 'Gamma ships billing']], 'The other page.\n')); commit(root, 'initial');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
    await claimWorktree(engine, id, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    try {
      const lines: string[] = [];
      const sync = () => performManagedSync(engine, { sourceId: id, noPull: true });
      await sync();
      const old = (await page(id, 'notes/plan'))!, other = (await page(id, 'notes/other'))!;
      git(root, 'mv', 'notes/plan.md', 'notes/roadmap.md'); write(root, 'notes/roadmap.md', doc([[1, 'Alpha ships payments']], 'An added paragraph.\n'));
      git(root, 'mv', 'notes/other.md', 'notes/another.md'); write(root, 'notes/another.md', doc([[1, 'Gamma ships billing']], 'The other page.\nAn added paragraph.\n'));
      commit(root, 'move and edit');
      const result = await sync();
      expect(result.identityDowngrades?.map(entry => entry.from).sort()).toEqual(['notes/other.md', 'notes/plan.md']);
      const fresh = (await page(id, 'notes/roadmap'))!;
      const close = ['gbrain', 'repair', 'rename-identity', '--source', id, '--slug', 'notes/roadmap', '--close'];
      // The restore alternative works on a managed source: the old page is live again beside its new page.
      const { operationsByName } = await import('../src/core/operations.ts');
      await operationsByName.restore_page!.handler({ engine, config: { engine: engine.kind }, remote: false, dryRun: false, logger: quiet, sourceId: id } as never, { slug: 'notes/other', source_id: id, force: true });
      expect(await pageById(other.id)).toMatchObject({ slug: 'notes/other', deleted_at: null });
      expect((await page(id, 'notes/another'))!.deleted_at).toBeNull();
      expect((await openRecords(id)).map(r => r.old_slug)).toEqual(['notes/plan']);

      // Every surface names --close as the only managed remedy, with the restore alternative and no other route.
      const { identityDowngradeLines, withIdentityRemedies } = await import('../src/core/sync-identity-downgrades.ts');
      const entries = await withIdentityRemedies(engine, (await openRecords(id)).filter(r => r.old_slug === 'notes/plan'));
      expect(structuredClone(entries[0]!.remedy)).toMatchObject({ disposition: 'close', carry_unavailable: 'managed_remedy_unavailable', preview_argv: close, consent: ['destructive'] });
      expect(entries[0]!.remedy.argv).toEqual([...close, '--apply', '--expect', entries[0]!.remedy.plan_hash, '--yes']);
      lines.push(...identityDowngradeLines(entries));
      const text = lines.join('\n');
      expect(text).toContain(`Carrying notes/plan's identity onto notes/roadmap is unavailable on a managed source (managed_remedy_unavailable); release the purge hold without carrying it (asks the user first: destructive): preview ${close.join(' ')}, then apply ${entries[0]!.remedy.argv.join(' ')}; or keep notes/plan as its own page: gbrain restore notes/plan --source-id ${id} --force`);
      const { readSyncStatus } = await import('../src/core/persistence/sync-status.ts');
      const status = (await readSyncStatus(engine, id, { detail: false })).identity_downgrades.find(entry => entry.old_slug === 'notes/plan')!;
      expect(status.remedy).toMatchObject({ disposition: 'close', carry_unavailable: 'managed_remedy_unavailable', preview_argv: close, plan_hash: entries[0]!.remedy.plan_hash });
      await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='sync-identity-downgrade' AND (completed_keys->0->>'source_id' <> $1 OR completed_keys->0->>'old_slug' <> 'notes/plan')", [id]);
      const { renameIdentityDowngradesEntry } = await import('../src/commands/doctor/checks/rename-identity-downgrades.ts');
      const [finding] = (await renameIdentityDowngradesEntry.run({ engine } as unknown as DoctorContext)) as unknown as Array<{ message: string; fix: Record<string, unknown> & { why: string } }>;
      expect(structuredClone(finding!.fix)).toMatchObject({ argv: entries[0]!.remedy.argv, preview_argv: close, consent: ['destructive'], ask_user: true, plan_hash: entries[0]!.remedy.plan_hash });
      expect(finding!.message).toContain('Carrying identity is unavailable on a managed source (managed_remedy_unavailable); to release the purge hold without carrying it, preview');
      expect(finding!.message).toContain(`gbrain restore notes/plan --source-id ${id} --force`);
      // The last report line is the general tip for future moves (S1), not a route for this pair.
      for (const said of [lines.slice(0, -1).join('\n'), finding!.message, finding!.fix.why, String(finding!.fix.user_message)]) expect(said).not.toMatch(/\bedit\b|git restore|move (it )?back/);

      // The carry preview states the code and writes nothing; its --apply refuses with it and moves no identity.
      const preview = await repairJson(['rename-identity', '--source', id, '--slug', 'notes/roadmap']);
      expect(structuredClone(preview)).toMatchObject({ mode: 'dry_run', affected: 0, residuals: { carry_unavailable: 1 },
        details: { code: 'managed_remedy_unavailable', close_preview: close.join(' '), restore: `gbrain restore notes/plan --source-id ${id} --force` },
        listing: [{ item: `${id}:notes/plan -> notes/roadmap`, class: 'managed_remedy_unavailable' }] });
      expect(preview.preview_hash).toBeUndefined();
      const carry = await refusal(() => repair(['rename-identity', '--source', id, '--slug', 'notes/roadmap', '--apply', '--expect', 'f'.repeat(64), '--yes']));
      expect(carry.code).toBe('managed_remedy_unavailable');
      expect(carry.suggestion).toContain(close.join(' '));
      expect(carry.suggestion).not.toMatch(/\bedit\b|git restore|move (it )?back/);
      expect((await page(id, 'notes/roadmap'))!.id).toBe(fresh.id);
      expect(await pageById(old.id)).toMatchObject({ slug: 'notes/plan', deleted_at: expect.anything() });
      expect(await disposition(old.id)).toBeNull();

      // --close settles the pair; the purge then takes the old page.
      await purgeDeletedPagesCoordinated(engine, 0);
      expect(await pageById(old.id)).toMatchObject({ slug: 'notes/plan', deleted_at: expect.anything() });
      const closing = await repairJson(['rename-identity', '--source', id, '--slug', 'notes/roadmap', '--close']);
      expect(closing.preview_hash).toBe(entries[0]!.remedy.plan_hash);
      expect(await repairJson(['rename-identity', '--source', id, '--slug', 'notes/roadmap', '--close', '--apply', '--expect', closing.preview_hash, '--yes'])).toMatchObject({ applied: 1, outcomes: { closed: 1 } });
      expect(await disposition(old.id)).toMatchObject({ kind: 'closed' });
      expect((await openRecords(id)).map(r => r.old_slug)).not.toContain('notes/plan');
      expect((await page(id, 'notes/roadmap'))!.id).toBe(fresh.id);
      expect((await purgeDeletedPagesCoordinated(engine, 0)).slugs).toContain('notes/plan');
      expect(await pageById(old.id)).toBeUndefined();

    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    }
  }), 240_000);
});
