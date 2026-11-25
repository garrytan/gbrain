/**
 * Restore safety on a Rust brain (src/core/backup/rust-restore-safety.ts, rust/crates/gbrain-store/src/restore.rs).
 *
 * PGLite repairs a restored brain with SQL; a Rust store takes typed members instead. One scenario runs on both: the
 * PGLite arm runs the real restore functions (`quarantineSharedSkillRestore`, `quarantineRestoredExecution` and the job
 * UPDATE of `restorePgliteBackup`), the Rust arm runs `restoreCensus` -> `buildQuarantinePlan` -> `restoreQuarantine`,
 * and both must end in `EXPECTED`. The Rust arm needs the addon `bun run rust:build` writes (rust/target/addon) and
 * skips without it; GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error (the Rust CI job sets it), and
 * GBRAIN_TEST_RUST_ENGINE_ADDON names another addon file (an older one shows the Rust arm failing first).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustStore, type RustStore } from '../src/core/rust-engine/store.ts';
import { quarantineRestoredExecution, type RestoredSource } from '../src/core/backup/quarantine.ts';
import { quarantineSharedSkillRestore } from '../src/core/shared-skills/restore.ts';
import { registerLocalWriterValue } from '../src/core/persistence/identity.ts';
import { CODES } from '../src/core/error-registry.ts';
import {
  RESTORE_REFUSAL_DOCS, RESTORE_REFUSAL_REASONS, buildQuarantinePlan, checkStoreIdentity, restoreAddonSupportsSafety, restoreRefusal, restoreRefusalFor,
} from '../src/core/backup/rust-restore-safety.ts';
import type { RestoreCensus } from '../src/core/rust-engine/restore-types.ts';

const TARGET = detectAddonTarget();
const BUILT = process.env.GBRAIN_TEST_RUST_ENGINE_ADDON
  ?? join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}
const withAddon = test.skipIf(!HAVE_ADDON);

const temporary = mkdtempSync(join(tmpdir(), 'gbrain-restore-safety-'));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

const OLD = '/old/home';
const NEW = join(temporary, 'new');
const RESTORE_ID = 'restore-parity';
const WRITER = '0b0b0b0b-0000-4000-8000-000000000001';
const CREDENTIAL = 'ab'.repeat(32);
const SOURCES: RestoredSource[] = [
  { id: 'conn', local_path: '/old/conn', managed_relative_path: null },
  { id: 'default', local_path: null, managed_relative_path: null },
  { id: 'managed', local_path: `${OLD}/files/m`, managed_relative_path: 'files/m' },
  { id: 'checkout', local_path: '/home/me/repo', managed_relative_path: null },
  { id: 'plain', local_path: null, managed_relative_path: null },
];
const CONNECTOR = { kind: 'api', remote_url: 'https://example.invalid/x', credential_cmd: 'pass show x', federated: true, strategy: 'latest' };
const SETTINGS: Array<[string, string]> = [
  ['connectors.gmail.auto_sync', 'true'], ['autopilot.dream.enabled', 'true'], ['sync.repo_path', `${OLD}/files/m/repo`],
  ['mcp.skills_dir', '/somewhere/else'], ['storage', '{}'], ['mine', '1'],
];
const JOB_STATUSES = ['waiting', 'active', 'delayed', 'paused', 'waiting-children', 'completed', 'failed'];
const PAGES: Array<[string, string, string]> = [
  ['managed', 'notes/a', `${OLD}/files/m/a/b.md`], ['managed', 'notes/b', `${OLD}/files/m/con.md`],
  ['managed', 'notes/c', '/elsewhere/c.md'], ['plain', 'notes/p', `${OLD}/files/m/a/b.md`],
];

/** What both arms must end with, whatever the engine. */
const EXPECTED = {
  sources: {
    checkout: { local_path: null, config: { syncEnabled: false, restore_detached: RESTORE_ID } },
    conn: { local_path: null, config: { federated: true, strategy: 'latest', syncEnabled: false, restore_detached: RESTORE_ID } },
    default: { local_path: null, config: { federated: true } },
    managed: { local_path: join(NEW, 'files', 'm'), config: { federated: false } },
    plain: { local_path: null, config: {} },
  },
  settings: {
    'connectors.gmail.auto_sync': 'false', 'autopilot.dream.enabled': 'false', 'sync.repo_path': join(NEW, 'files', 'm', 'repo'),
    'mcp.skills_dir': null, storage: null, mine: '1',
  },
  origins: {
    'managed/notes/a': join(NEW, 'files', 'm', 'a', 'b.md'), 'managed/notes/b': `${OLD}/files/m/con.md`,
    'managed/notes/c': '/elsewhere/c.md', 'plain/notes/p': `${OLD}/files/m/a/b.md`,
  },
  jobs: JOB_STATUSES.map(status => {
    const live = !['completed', 'failed'].includes(status);
    return { status: live ? 'cancelled' : status, previous: live ? status : null, restore: live ? RESTORE_ID : null, keep: 1 };
  }),
};
/** What only the PGLite restore does: it revokes the archived local writer and OAuth client; the Rust restore refuses an archive that holds either (below). */
const PGLITE_REVOKES = { writerRevoked: true, clientDeleted: true };

type Outcome = typeof EXPECTED;

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' });
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });

async function pgliteArm(): Promise<Outcome & typeof PGLITE_REVOKES> {
  for (const [id, path, config] of [['conn', '/old/conn', CONNECTOR], ['managed', `${OLD}/files/m`, { federated: false }],
    ['checkout', '/home/me/repo', { canonical: 'git' }], ['plain', null, {}]] as const) {
    await engine.executeRaw('INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, $3::text::jsonb)', [id, path, JSON.stringify(config)]);
  }
  await engine.executeRaw("UPDATE sources SET archived = true WHERE id = 'conn'");
  for (const [source, slug, origin] of PAGES) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'text', timeline: '' }, { sourceId: source });
    await engine.executeRaw('UPDATE pages SET source_path = $1 WHERE source_id = $2 AND slug = $3', [origin, source, slug]);
  }
  for (const [key, value] of SETTINGS) await engine.setConfig(key, value);
  for (const status of JOB_STATUSES) {
    await engine.executeRaw("INSERT INTO minion_jobs (name, queue, status, data, submission_authority) VALUES ('work', 'default', $1, '{\"keep\":1}'::jsonb, '{\"version\":1,\"kind\":\"application\"}'::jsonb)", [status]);
  }
  await registerLocalWriterValue(engine, { id: WRITER, credential: CREDENTIAL, lane: 'cli' });
  await engine.executeRaw("INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, scope) VALUES ('c1', 'one', '{}', '{}', 'read')");
  await engine.transaction(async tx => {
    await quarantineSharedSkillRestore(tx, RESTORE_ID);
    await quarantineRestoredExecution(tx, { sources: SOURCES, originalRoot: OLD, root: NEW, managedPaths: ['files'], restoreId: RESTORE_ID });
    await tx.executeRaw(`UPDATE minion_jobs SET status = 'cancelled', lock_token = NULL, lock_until = NULL, finished_at = NOW(), updated_at = NOW(), error_text = 'quarantined by backup restore; inspect and explicitly resubmit', data = data || jsonb_build_object('__restore_previous_status', status, '__restore_id', $1::text) WHERE status NOT IN ('completed', 'failed', 'dead', 'cancelled')`, [RESTORE_ID]);
  });
  const sources = Object.fromEntries((await engine.executeRaw<{ id: string; local_path: string | null; config: Record<string, unknown> }>(
    'SELECT id, local_path, config FROM sources ORDER BY id')).map(r => [r.id, { local_path: r.local_path, config: r.config }]));
  const settings = Object.fromEntries(await Promise.all(SETTINGS.map(async ([key]) => [key, await engine.getConfig(key)] as const)));
  const origins = Object.fromEntries((await engine.executeRaw<{ source_id: string; slug: string; source_path: string }>(
    'SELECT source_id, slug, source_path FROM pages ORDER BY source_id, slug')).map(r => [`${r.source_id}/${r.slug}`, r.source_path]));
  const jobs = (await engine.executeRaw<{ status: string; data: Record<string, unknown> }>('SELECT status, data FROM minion_jobs ORDER BY id'))
    .map(r => ({ status: r.status, previous: (r.data.__restore_previous_status as string) ?? null, restore: (r.data.__restore_id as string) ?? null, keep: r.data.keep as number }));
  const [writer] = await engine.executeRaw<{ revoked: boolean }>('SELECT revoked_at IS NOT NULL AS revoked FROM persistence_local_writers WHERE id = $1::uuid', [WRITER]);
  const [client] = await engine.executeRaw<{ deleted: boolean }>("SELECT deleted_at IS NOT NULL AS deleted FROM oauth_clients WHERE client_id = 'c1'");
  return { sources, settings, origins, jobs, writerRevoked: writer!.revoked, clientDeleted: client!.deleted } as Outcome & typeof PGLITE_REVOKES;
}

let addon: RustAddon | undefined;

async function rustArm(): Promise<Outcome> {
  addon ??= await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  const dir = join(temporary, `rust-${Math.random().toString(36).slice(2)}`);
  const store = await openRustStore(addon, dir);
  const b = store.brain;
  try {
    for (const [id, path, config] of [['conn', '/old/conn', CONNECTOR], ['managed', `${OLD}/files/m`, { federated: false }],
      ['checkout', '/home/me/repo', { canonical: 'git' }], ['plain', null, {}]] as const) {
      await b.upsertSource({ id, name: id, local_path: path, config });
    }
    await b.setSourceArchived('conn', true);
    for (const [source, slug, origin] of PAGES) {
      await b.putPage(slug, { type: 'note', title: slug, compiled_truth: 'text', source_path: origin }, { sourceId: source });
    }
    for (const [key, value] of SETTINGS) await b.setConfig(key, value);
    for (const status of JOB_STATUSES) {
      await b.admitJob({ maxSpawnDepth: 5, insert: { name: 'work', queue: 'default', status, priority: 0, data: { keep: 1 }, max_attempts: 3,
        backoff_type: 'fixed', backoff_delay: 1000, backoff_jitter: 0, on_child_fail: 'fail_parent', remove_on_complete: false,
        remove_on_fail: false, submission_authority: { version: 1, kind: 'application' } } });
    }

    const census = await store.restoreCensus([]);
    expect(census.blockers).toEqual([]);
    const report = await store.restoreQuarantine(buildQuarantinePlan({ restoreId: RESTORE_ID, census, sources: SOURCES, originalRoot: OLD, root: NEW, managedPaths: ['files'] }));
    expect(report).not.toHaveProperty('revoked');
    const sources = Object.fromEntries((await b.listAllSources({ includeArchived: true }) as Array<{ id: string; local_path: string | null; config: Record<string, unknown> }>)
      .map(r => [r.id, { local_path: r.local_path, config: r.config }]));
    const settings = Object.fromEntries(await Promise.all(SETTINGS.map(async ([key]) => [key, await b.getConfig(key)] as const)));
    const origins: Record<string, string> = {};
    for (const source of ['managed', 'plain']) {
      for (const row of await b.listPages({ sourceId: source, limit: 100 }) as Array<{ slug: string; source_path: string }>) origins[`${source}/${row.slug}`] = row.source_path;
    }
    const jobs = (await Promise.all([1, 2, 3, 4, 5, 6, 7].map(id => b.getJob(id)))).map((r: { status: string; data: Record<string, unknown> }) => (
      { status: r.status, previous: (r.data.__restore_previous_status as string) ?? null, restore: (r.data.__restore_id as string) ?? null, keep: r.data.keep as number }));
    return { sources, settings, origins, jobs } as Outcome;
  } finally { await store.close(); }
}

describe('one restore scenario, both engines', () => {
  test('PGLite: the SQL restore ends in the expected state', async () => {
    expect(await pgliteArm()).toEqual({ ...EXPECTED, ...PGLITE_REVOKES });
  });
  withAddon('Rust: the typed restore ends in the same state', async () => {
    expect(await rustArm()).toEqual(EXPECTED);
  });
  withAddon('Rust: the restored store has a fresh brain id in its records and in FORMAT, and opens again', async () => {
    addon ??= await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
    const dir = join(temporary, 'fresh-id');
    const first = await openRustStore(addon, dir);
    let previous: string;
    let fresh: string;
    try {
      const census = await first.restoreCensus([]);
      previous = census.store.brain_id;
      const report = await first.restoreQuarantine({ restore_id: 'r-id', sources: [{ id: 'default', local_path: null, rebased_path: null }], settings: [] });
      fresh = report.brain_id;
      expect(report.previous_brain_id).toBe(previous);
      expect(fresh).not.toBe(previous);
      expect(report.reconnect.some(line => line.includes(fresh) && line.includes(previous))).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, 'FORMAT'), 'utf8')).brain_id).toBe(fresh);
      // The handle that ran the restore reports the fresh id too, not the one it replaced.
      expect((await first.restoreCensus([])).store.brain_id).toBe(fresh);
      expect(await first.brain.getBrainIdentity()).toEqual({ brain_id: fresh });
    } finally { await first.close(); }
    const again = await openRustStore(addon, dir);
    try {
      expect((await again.restoreCensus([])).store.brain_id).toBe(fresh);
    } finally { await again.close(); }
  });
  withAddon('Rust: an archive that holds a live OAuth client or local writer is refused by name before anything changes', async () => {
    addon ??= await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
    const plan = { restore_id: 'r-auth', sources: [{ id: 'default', local_path: null, rebased_path: null }], settings: [] };
    for (const [name, seed] of [
      ['oauth', (b: RustStore['brain']) => b.insertOauthClient({ client_id: 'c1', client_name: 'one', scope: 'read' })],
      ['writer', (b: RustStore['brain']) => b.registerLocalWriter({ id: WRITER, lane: 'cli', credentialHash: CREDENTIAL, grantCeiling: null })],
    ] as const) {
      const store = await openRustStore(addon, join(temporary, `authority-${name}`));
      try {
        await seed(store.brain);
        const census = await store.restoreCensus([]);
        expect(census.blockers).toEqual([{ reason: 'archived_authority', count: 1, detail: expect.stringContaining(name === 'oauth' ? 'c1' : WRITER) }]);
        await expect(store.restoreQuarantine(plan)).rejects.toMatchObject({ code: 'restore_refused', message: expect.stringContaining('archived_authority: 1') });
        // Nothing was revoked and the brain id is the one it had.
        expect(await store.restoreCensus([])).toEqual(census);
        expect(restoreRefusalFor({ census, mode: 'new_brain', mirror: 'ok' })?.reason).toBe('archived_authority');
      } finally { await store.close(); }
    }
  });
  withAddon('Rust: unfinished work refuses by name, and the refusal changes nothing', async () => {
    addon ??= await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
    const store = await openRustStore(addon, join(temporary, 'busy'));
    try {
      const before = await store.restoreCensus([]);
      expect(before.store.engine_format_version).toBeGreaterThan(0);
      await store.brain.setConfig('autopilot.x.enabled', 'true');
      const plan = { restore_id: 'r', sources: [{ id: 'default', local_path: null, rebased_path: null }], settings: [{ key: 'version', value: '1' }] };
      await expect(store.restoreQuarantine(plan)).rejects.toMatchObject({ code: 'invalid_argument' });
      expect(await store.brain.getConfig('autopilot.x.enabled')).toBe('true');
      const missing = await store.restoreCensus(['0a0a0a0a-0000-4000-8000-0000000000aa']);
      expect(missing.blockers).toEqual([{ reason: 'purge_replay', count: 1 }]);
      // Real unfinished work: a queued write request crosses the addon boundary as `restore_refused`, and the refusal changes nothing.
      const principal = { kind: 'local_cli', id: 'cli' };
      const held = await store.brain.admitWrite({ principal, operation: 'put_page', sourceId: 'default', slug: 'notes/held',
        requestId: '0a0a0a0a-0000-4000-8000-0000000000bb', callerIntent: { slug: 'notes/held' }, intent: {} });
      const busy = await store.restoreCensus([]);
      expect(busy.requests).toEqual({ queued: 1 });
      expect(busy.blockers).toEqual([{ reason: 'pending_requests', count: 1 }]);
      await expect(store.restoreQuarantine({ ...plan, settings: [] })).rejects.toMatchObject({ code: 'restore_refused', message: expect.stringContaining('pending_requests') });
      expect(await store.restoreCensus([])).toEqual(busy);
      expect(await store.brain.getConfig('autopilot.x.enabled')).toBe('true');
      await store.brain.finishWrite(principal, held.request_id, { state: 'cancelled' });
      expect((await store.restoreCensus([])).blockers).toEqual([]);
      // A plan that leaves a held setting out is refused whole: the archived automation stays as it was.
      await expect(store.restoreQuarantine({ ...plan, settings: [] })).rejects.toMatchObject({ code: 'invalid_argument' });
      expect(await store.brain.getConfig('autopilot.x.enabled')).toBe('true');
      const complete = { ...plan, settings: [{ key: 'autopilot.x.enabled', value: 'false' }] };
      await expect(store.restoreQuarantine(complete)).resolves.toMatchObject({ jobs_cancelled: 0 });
      expect(await store.brain.getConfig('autopilot.x.enabled')).toBe('false');
      await expect(store.restoreQuarantine(complete)).rejects.toMatchObject({ code: 'invalid_state' });
    } finally { await store.close(); }
  });
});

const census = (over: Partial<RestoreCensus> = {}): RestoreCensus => ({
  store: { engine_format_version: 5, schema_version: 319, brain_id: 'b', generation: 7 }, requests: {}, claims: 0, effects_live: 0,
  recovery_records: 0, jobs_live: 0, authority: { local_writers: [], oauth_clients: [] }, sources: [], settings: [], purges_present: [],
  purges_missing: [], unclassified: [], blockers: [], ...over,
});

describe('refusals', () => {
  test('every reason is registered, documented, and says what was not published and the fix', () => {
    expect([...CODES.restore_step_unsupported.reasons!].sort()).toEqual([...RESTORE_REFUSAL_REASONS].sort());
    expect(readFileSync(join(import.meta.dir, '..', 'docs', 'guides', 'troubleshooting.md'), 'utf8')).toContain(`<a id="${RESTORE_REFUSAL_DOCS.split('#')[1]}"></a>`);
    for (const reason of RESTORE_REFUSAL_REASONS) {
      const error = restoreRefusal(reason, 3, { store: census().store }).toJSON() as Record<string, unknown>;
      expect(error.error).toBe('restore_step_unsupported');
      expect(error.reason).toBe(reason);
      expect(String(error.message)).toContain('Nothing was published');
      expect(String(error.message)).toContain('restore_target_exists');
      expect(String(error.suggestion)).toContain('new absent --into');
      expect(error.docs).toBe(RESTORE_REFUSAL_DOCS);
      expect(JSON.stringify(error)).not.toMatch(/--(skip|no)-/i);
      expect(String(error.detail)).toContain('store_format=5 generation=7');
    }
  });

  test('a mode or mirror the Rust restore cannot serve is refused first; a blocker is named; a clean census passes', () => {
    const busy = census({ blockers: [{ reason: 'pending_requests', count: 2 }, { reason: 'purge_replay', count: 1 }] });
    expect(restoreRefusalFor({ census: busy, mode: 'recovery', mirror: 'ok' })?.reason).toBe('recovery_mode');
    expect(restoreRefusalFor({ census: busy, mode: 'new_brain', mirror: 'corrupt' })?.reason).toBe('purge_mirror_unreadable');
    expect(restoreRefusalFor({ census: busy, mode: 'new_brain', mirror: 'ok' })?.reason).toBe('pending_requests');
    const tokens = restoreRefusalFor({ census: census({ blockers: [{ reason: 'unclassified_state', count: 1, detail: 'access tokens (jobs 0x2b)' }] }), mode: 'new_brain', mirror: 'ok' });
    expect(tokens?.reason).toBe('unclassified_state');
    expect(tokens?.message).toContain('access tokens (jobs 0x2b)');
    expect(tokens?.message).toContain('not revoked by this restore');
    expect(restoreRefusalFor({ census: census(), mode: 'new_brain', mirror: 'unavailable' })).toBeNull();
  });

  test('live OAuth client or local writer authority is refused by name, with the fix, and nothing was published', () => {
    const held = census({ authority: { local_writers: [], oauth_clients: ['c1'] }, blockers: [{ reason: 'archived_authority', count: 1, detail: 'OAuth clients c1' }] });
    const error = restoreRefusalFor({ census: held, mode: 'new_brain', mirror: 'ok' })!.toJSON() as Record<string, unknown>;
    expect(error.error).toBe('restore_step_unsupported');
    expect(error.reason).toBe('archived_authority');
    expect(String(error.message)).toContain('OAuth clients c1');
    expect(String(error.message)).toContain('does not revoke them yet');
    expect(String(error.message)).toContain('Nothing was published');
    expect(String(error.suggestion)).toContain('Re-issue tokens on the live brain');
    expect(String(error.suggestion)).toContain('archive taken without them');
    expect(String(error.suggestion)).toContain('follow-up release that adds revocation');
  });

  test('an addon without the restore members is detected', () => {
    class Old {}
    class Current { restoreCensus() {} restoreQuarantine() {} }
    expect(restoreAddonSupportsSafety({ Brain: Old })).toBe(false);
    expect(restoreAddonSupportsSafety({})).toBe(false);
    expect(restoreAddonSupportsSafety({ Brain: Current })).toBe(true);
  });
});

describe('store identity in an archive', () => {
  const store = census().store;
  const metadata = { format_version: 1, kind: 'gbrain-rust', store: { engine_format_version: 5, schema_version: 319, brain_id: 'b', generation: 7 } };

  test('a format-5 store in a container at version 1 matches', () => {
    expect(() => checkStoreIdentity(metadata, store)).not.toThrow();
  });

  test('the container version is never read as the store version, and each field must match', () => {
    expect(() => checkStoreIdentity({ ...metadata, store: { ...metadata.store, engine_format_version: 1 } }, store)).toThrow('format');
    for (const [field, value, name] of [['schema_version', 1, 'schema version'], ['brain_id', 'other', 'brain id'], ['generation', 8, 'generation']] as const) {
      expect(() => checkStoreIdentity({ ...metadata, store: { ...metadata.store, [field]: value } }, store)).toThrow(name);
    }
    expect(() => checkStoreIdentity({ format_version: 1 }, store)).toThrow('identity is missing');
    expect(() => checkStoreIdentity({ format_version: 5 }, store)).toThrow('identity is missing');
  });
});
