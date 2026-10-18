/**
 * #6741 C follow-up (v3 review): the managed purge's selection, retry and
 * phase outcome.
 *
 * Protects: one eligibility selector behind the dry-run preview, the consent
 * request and the real purge (`--retry-parked` round-trips through all three,
 * the consent names the parked count, and the `--older-than` cutoff still applies:
 * a parked page younger than the cutoff is not retried); the #6729
 * rename-recovery hold (`identityDowngradePurgeHold`) keeps a held page out of the
 * purge and out of `--retry-parked`; a source whose writer needs recovery and a
 * parked page make the cycle purge phase warn instead of fail; doctor
 * `purge_parked_pages` renders actor agent on the CLI and host_admin remotely; and the
 * end-to-end path from the exit-3 consent argv through an approved rerun to a
 * cycle against a source in recovery.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCycle } from '../src/core/cycle.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { purgeConsentRequest, purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { IDENTITY_DOWNGRADE_OP } from '../src/core/sync-identity-downgrades.ts';
import { purgeStaleCheckpoints } from '../src/core/op-checkpoint.ts';
import { PURGE_PARK_OP, readPurgeParks } from '../src/core/persistence/purge-parks.ts';
import { runPages } from '../src/commands/pages.ts';
import { STRICT_SUBCOMMANDS } from '../src/cli/strict-args.ts';
import { checkPurgeParkedPages } from '../src/commands/doctor/checks/purge-parks.ts';
import { computeDoctorReport } from '../src/commands/doctor.ts';
import { cliRenderContext } from '../src/core/agent-output.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const SOURCE = 'purge-v3';
const ORDINARY = 'notes/ordinary', PARKED = 'notes/parked', HELD = 'notes/held';
let engine: PGLiteEngine;
let dir: string;
let root: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
});

const env = () => ({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
  OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, GBRAIN_CONSENT: undefined });
const logger = { info() {}, warn() {}, error() {} };
const ctx = (): OperationContext => ({ engine, sourceId: SOURCE, remote: false, dryRun: false, logger,
  config: { engine: engine.kind, embedding_disabled: true } as never });

beforeEach(async () => {
  _resetCliExitVerdictForTests();
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  dir = mkdtempSync(join(tmpdir(), 'gb-purge-v3-'));
  root = join(dir, 'brain');
  mkdirSync(root);
  await withEnv(env(), async () => {
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [SOURCE, root]);
    await engine.setConfig('sync.write_through', 'true');
    await claimWorktree(engine, SOURCE, root);
  });
});

afterEach(async () => {
  _resetCliExitVerdictForTests();
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('DROP TRIGGER IF EXISTS purge_v3_refuse ON pages');
  rmSync(dir, { recursive: true, force: true });
});

/** A page soft-deleted `hours` ago, through the coordinator like any managed delete. */
async function expired(slug: string, hours = 100): Promise<void> {
  await withEnv(env(), async () => {
    await submitPageMutation(ctx(), { operation: 'put_page', params: { slug, content: `---\ntitle: ${slug}\ntype: note\n---\nGone soon.`, request_id: randomUUID() } });
    const snapshot = await engine.readPageSnapshot(slug, { sourceId: SOURCE });
    await submitPageMutation(ctx(), { operation: 'delete_page', params: { slug, expected_revision: snapshot!.revision, request_id: randomUUID() } });
  });
  // The backdate is a fixture write outside coordination, so the managed guard is off for it.
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw(`UPDATE pages SET deleted_at=now() - ($3 || ' hours')::interval WHERE source_id=$1 AND slug=$2`, [SOURCE, slug, String(hours)]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
}
/** An open #6729 rename-identity downgrade record on the soft-deleted page (no disposition yet): the purge must leave it. */
async function holdRename(slug: string): Promise<void> {
  const [page] = await engine.executeRaw<{ id: number | string }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [SOURCE, slug]);
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2::text,jsonb_build_array(jsonb_build_object('source_id',$3::text,'old_slug',$4::text,'old_deleted_at',(SELECT deleted_at::text FROM pages WHERE id::text=$2::text))))`,
    [IDENTITY_DOWNGRADE_OP, String(page!.id), SOURCE, slug]);
}
async function refuse(slug: string): Promise<void> {
  await engine.executeRaw(`CREATE OR REPLACE FUNCTION purge_v3_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic purge refusal'; END $$`);
  await engine.executeRaw('DROP TRIGGER IF EXISTS purge_v3_refuse ON pages');
  await engine.executeRaw(`CREATE TRIGGER purge_v3_refuse BEFORE DELETE ON pages FOR EACH ROW WHEN (OLD.slug = '${slug}') EXECUTE FUNCTION purge_v3_refuse()`);
}
const allow = () => engine.executeRaw('DROP TRIGGER IF EXISTS purge_v3_refuse ON pages');
const purge = (opts?: { retryParked?: boolean }) => withEnv(env(), () => purgeDeletedPagesCoordinated(engine, 72, opts));
/** Parks `slug` (five refused purges); every other expired page in the brain is purged on the way. */
async function park(slug: string): Promise<void> {
  await refuse(slug);
  for (let attempt = 1; attempt <= 5; attempt++) await purge();
  expect(await purge()).toMatchObject({ parked: 1 });
}
const attempts = async (slug: string) => (await engine.executeRaw(
  "SELECT 1 FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND operation='delete_page' AND (intent->>'purge')::boolean IS TRUE", [SOURCE, slug])).length;
const lifetimeIds = async () => Number((await engine.executeRaw<{ n: string }>("SELECT lifetime_ids::text AS n FROM persistence_counters WHERE key='brain'"))[0]?.n ?? 0);
const exists = async (slug: string) => (await engine.executeRaw('SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2', [SOURCE, slug])).length > 0;
const setWorktree = (state: 'active' | 'recovering') =>
  engine.executeRaw('UPDATE persistence_worktrees w SET state=$2 FROM persistence_source_bindings b WHERE b.worktree_id=w.id AND b.source_id=$1', [SOURCE, state]);
async function cli(args: string[]): Promise<string> {
  const out: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { out.push(parts.map(String).join(' ')); });
  const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as never);
  const err = spyOn(console, 'error').mockImplementation(() => {});
  const errWrite = spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  try { await withEnv(env(), () => runPages(engine, args)); await new Promise(resolve => setTimeout(resolve, 10)); }
  finally { log.mockRestore(); write.mockRestore(); err.mockRestore(); errWrite.mockRestore(); }
  return out.join('');
}
const dryRun = async (...flags: string[]) => JSON.parse(await cli(['purge-deleted', ...flags, '--dry-run', '--json']));
const cycle = () => withEnv(env(), () => runCycle(engine, { brainDir: root, phases: ['purge'], sourceId: SOURCE }));

describe('#6741 C v3: --retry-parked rides one eligibility selector', () => {
  test('the strict argument table accepts --retry-parked for pages purge-deleted', () => {
    expect(JSON.stringify(STRICT_SUBCOMMANDS['pages purge-deleted'])).toContain('--retry-parked');
  });

  test('the dry run, the consent request and the real purge select the same pages, with and without --retry-parked', async () => {
    await expired(PARKED);
    await park(PARKED);
    await expired(ORDINARY);
    const without = await dryRun();
    expect(without).toMatchObject({ count: 1, slugs: [ORDINARY], parked: [{ slug: PARKED, failures: 5, retried: false }] });
    const withRetry = await dryRun('--retry-parked');
    expect(withRetry).toMatchObject({ count: 2, retry_parked: true, parked: [{ slug: PARKED, failures: 5, retried: true }] });
    expect([...withRetry.slugs].sort()).toEqual([ORDINARY, PARKED].sort());
    const consent = purgeConsentRequest(withRetry.count, 72, true, [], true, 1);
    expect(consent.user_message).toContain('1 parked');
    expect(consent.what).toContain('1 parked');
    expect(consent.argv).toEqual(['gbrain', 'pages', 'purge-deleted', '--older-than', '72h', '--retry-parked', '--json', '--yes']);
    expect(consent.preview_argv).toEqual(['gbrain', 'pages', 'purge-deleted', '--older-than', '72h', '--retry-parked', '--dry-run', '--json']);
    await allow();
    const result = await purge({ retryParked: true });
    expect([...result.slugs].sort()).toEqual([...withRetry.slugs].sort());
  }, 120_000);

  test('--older-than still applies to --retry-parked: a parked page younger than the cutoff is not retried', async () => {
    await expired(PARKED);
    await park(PARKED);
    await allow();
    expect(await dryRun('--retry-parked', '--older-than', '200h')).toMatchObject({ count: 0, slugs: [] });
    const before = await lifetimeIds();
    await cli(['purge-deleted', '--retry-parked', '--older-than', '200h', '--json', '--yes']);
    expect(await lifetimeIds()).toBe(before);
    expect(await exists(PARKED)).toBe(true);
    // A purged page's requests leave with it, so the attempt is counted in permanent request ids.
    await cli(['purge-deleted', '--retry-parked', '--older-than', '72h', '--json', '--yes']);
    expect(await lifetimeIds()).toBe(before + 1);
    expect(await exists(PARKED)).toBe(false);
  }, 120_000);

  test('the consent request names the parked count it retries', async () => {
    await expired(PARKED);
    await park(PARKED);
    const payload = JSON.parse(await cli(['purge-deleted', '--retry-parked', '--json']));
    expect(currentExitCode()).toBe(3);
    expect(payload.user_message).toContain('1 parked');
  }, 120_000);
});

describe('#6741 C v3: the #6729 rename-recovery hold', () => {
  test('a held page is neither purged nor retried, parked or not', async () => {
    await expired(HELD);
    await park(HELD);
    await holdRename(HELD);
    await allow();
    const before = await attempts(HELD);
    expect(await dryRun('--retry-parked')).toMatchObject({ count: 0, slugs: [] });
    expect((await purge({ retryParked: true })).slugs).toEqual([]);
    await cli(['purge-deleted', '--retry-parked', '--json', '--yes']);
    expect(await purge()).toMatchObject({ count: 0, parked: 0 });
    expect(await attempts(HELD)).toBe(before);
    expect(await exists(HELD)).toBe(true);
  }, 120_000);
});

describe('#6741 C v3: the cycle purge phase warns instead of failing', () => {
  test('a source whose writer needs recovery: warn, nothing submitted', async () => {
    await expired(ORDINARY);
    await setWorktree('recovering');
    const before = await lifetimeIds();
    const report = await cycle();
    const phase = report.phases.find(p => p.phase === 'purge')!;
    expect(phase.status).toBe('warn');
    expect(phase.error).toBeUndefined();
    expect(phase.details.purged_pages_blocked).toEqual([expect.objectContaining({ slug: ORDINARY, code: 'writer_not_active', binding_state: 'recovery_required' })]);
    expect(await lifetimeIds()).toBe(before);
    expect(await exists(ORDINARY)).toBe(true);
  }, 120_000);

  test('a parked page: warn, and the parked page takes no request id', async () => {
    await expired(PARKED);
    await park(PARKED);
    const before = await lifetimeIds();
    const phase = (await cycle()).phases.find(p => p.phase === 'purge')!;
    expect(phase.status).toBe('warn');
    expect(phase.details.purged_pages_blocked).toEqual([expect.objectContaining({ slug: PARKED, code: 'purge_parked' })]);
    expect(await lifetimeIds()).toBe(before);
  }, 120_000);
});

describe('#6741 C v3: the op_checkpoints GC keeps parks', () => {
  test('a park untouched for 8 days survives purgeStaleCheckpoints and the cycle purge phase; an ordinary stale row does not', async () => {
    await expired(PARKED);
    await park(PARKED);
    await engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('purge-v3-control','stale','[]'::jsonb)");
    const backdate = () => engine.executeRaw("UPDATE op_checkpoints SET updated_at=now() - interval '8 days' WHERE op IN ($1,'purge-v3-control')", [PURGE_PARK_OP]);
    await backdate();
    expect(await purgeStaleCheckpoints(engine, 7)).toBeGreaterThanOrEqual(1);
    expect((await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='purge-v3-control'")).length).toBe(0);
    expect([...(await readPurgeParks(engine)).values()]).toEqual([expect.objectContaining({ slug: PARKED, failures: 5 })]);
    // The cycle purge phase runs the same GC (7-day TTL) after the purge.
    await backdate();
    const phase = (await cycle()).phases.find(p => p.phase === 'purge')!;
    expect(phase.status).toBe('warn');
    expect([...(await readPurgeParks(engine)).values()]).toEqual([expect.objectContaining({ slug: PARKED, failures: 5 })]);
    expect(await purge()).toMatchObject({ parked: 1 });
  }, 120_000);
});

describe('#6741 C v3: doctor purge_parked_pages actor', () => {
  test('renders actor agent on the CLI and host_admin on the remote doctor path', async () => {
    await expired(PARKED);
    await park(PARKED);
    const finding = await checkPurgeParkedPages(engine);
    const local = computeDoctorReport([finding], { render: cliRenderContext() }).checks[0]!.fix;
    expect(local).toMatchObject({ actor: 'agent', next: 'ask_user', argv: ['gbrain', 'pages', 'purge-deleted', '--retry-parked', '--yes'] });
    // The render context run_doctor builds for a remote caller (src/commands/doctor/remote-tier.ts).
    const remoteRender = { transport: 'http', isCallable: (op: string) => op === 'run_doctor' || op === 'get_brain_health', preapproved: () => false } as const;
    const remote = computeDoctorReport([await checkPurgeParkedPages(engine)], { render: remoteRender }).checks[0]!.fix;
    expect(remote).toMatchObject({ actor: 'host_admin', next: 'ask_user' });
  }, 120_000);
});

describe('#6741 C v3: end to end', () => {
  test('exit-3 consent argv, an approved rerun over parked, ordinary and rename-held pages, then a cycle against a source in recovery', async () => {
    await expired(PARKED);
    await park(PARKED);
    await expired(ORDINARY);
    await expired(HELD);
    await holdRename(HELD);
    // 1. Without --yes: exit 3 with the consent payload and the exact argv to run once the user agrees.
    const payload = JSON.parse(await cli(['purge-deleted', '--retry-parked', '--json']));
    expect(currentExitCode()).toBe(3);
    expect(payload.user_message).toContain('1 parked');
    expect(payload.fix.argv).toEqual(['gbrain', 'pages', 'purge-deleted', '--older-than', '72h', '--retry-parked', '--json', '--yes']);
    expect(await exists(ORDINARY)).toBe(true);
    // 2. The user agreed and the cause of the parked failures is fixed: run the argv.
    _resetCliExitVerdictForTests();
    await allow();
    const idsBefore = await lifetimeIds(), heldBefore = await attempts(HELD);
    const ran = JSON.parse(await cli(payload.fix.argv.slice(2)));
    expect([...ran.slugs].sort()).toEqual([ORDINARY, PARKED].sort());
    expect(await lifetimeIds()).toBe(idsBefore + 2);
    expect(await attempts(HELD)).toBe(heldBefore);
    expect(await exists(ORDINARY)).toBe(false);
    expect(await exists(PARKED)).toBe(false);
    expect(await exists(HELD)).toBe(true);
    expect(currentExitCode()).toBe(0);
    // 3. A later page expires while the writer is in recovery: the cycle warns and submits nothing.
    await expired('notes/later');
    await setWorktree('recovering');
    const before = await lifetimeIds();
    const phase = (await cycle()).phases.find(p => p.phase === 'purge')!;
    expect(phase.status).toBe('warn');
    expect(await lifetimeIds()).toBe(before);
    expect(await exists('notes/later')).toBe(true);
    expect(await exists(HELD)).toBe(true);
  }, 180_000);
});
