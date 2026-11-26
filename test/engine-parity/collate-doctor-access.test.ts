/**
 * BrainEngine parity: the access doctor checks list the credentials, clients, sources and pages they name in byte order
 * on every engine arm and locale.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the check functions behind `gbrain doctor` (attest_read_shared_scope, access_may_act_for_wildcard,
 *    grant_new_ops_available, unscoped_multi_user_token, oauth_client_scope_health, access_readers_malformed,
 *    access_unknown_readers, guest_source, access_policy_pending, storage_manifest, generation_retirements,
 *    generation_held, privacy_label_ignored) print the keys they name (credential kind and name, client ids, grant ids,
 *    orphaned source ids, page source ids and slugs, reader ids, label values, per-source counts) in the same order on
 *    every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1): byte
 *    order, as PGLite and the Rust store sort. Each check still fires on the keys seeded here.
 *  - Regression: an en_US Postgres sorted these keys by its locale, which skips punctuation (`ab` before `a-z`) and
 *    folds case, so the doctor message, `details` and the "first five shown" cut came back in another order than on
 *    PGLite and Rust brains.
 *  - Why existing coverage misses it: the checks' tests seed keys that sort the same in every locale, and CI's Postgres
 *    runs in C.UTF-8. Every case here mixes `a-z`, `ab`, `a.b`, `a_b` (and an upper-case `B`) in the keys; run it against
 *    an en_US Postgres to see it fail.
 *  - Seam: none. The checks run as shipped; the keys they name are seeded through typed writers (insertOauthClient,
 *    insertUnifiedToken and writeCredentialBinding, putPage, the harness source fixture and activateGenerationRows /
 *    recordHeldGenerationRow), and the checks read them through typed members the Rust store serves.
 *  - Not exercised: `held_reason` (generation_held) and the `key` of privacy_label_ignored take values from a closed set
 *    whose members already sort the same by byte and by en_US, so no seed can tell the orders apart there; the first
 *    key of the same ORDER BY does.
 */
import { describe, expect } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createSource, parityArms, restrictFolder, type ParityBackend } from './harness.ts';
import type { OauthClientInsert } from '../../src/core/engine-sql/oauth-clients.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { BYTE_IDS, BYTE_SLUGS, MIXED_IDS, MIXED_SLUGS, byteOrder } from '../helpers/byte-order.ts';
import { isValidSourceId } from '../../src/core/source-id.ts';
import { insertUnifiedToken } from '../../src/core/token-mint.ts';
import { resolveGrantProfile } from '../../src/core/grants/service.ts';
import { attestReadAccessEntry } from '../../src/commands/doctor/checks/attest-read-access.ts';
import { sharedAgentAccessEntry } from '../../src/commands/doctor/checks/shared-agent-access.ts';
import { checkGrantNewOps } from '../../src/commands/doctor/checks/grant-new-ops.ts';
import { unscopedMultiUserTokenEntry } from '../../src/commands/doctor/checks/unscoped-multi-user-token.ts';
import { checkOauthClientScopeHealth, DCR_PRIVILEGED_SCOPES } from '../../src/commands/doctor/checks/routing-federation.ts';
import { memberAccessEntry } from '../../src/commands/doctor/checks/member-access.ts';
import { guestSourceCheck } from '../../src/commands/doctor/checks/guest-source.ts';
import { folderAccessEntry } from '../../src/commands/doctor/checks/folder-access.ts';
import { storageManifestCheck } from '../../src/commands/doctor/checks/storage-manifest.ts';
import { generationHeldCheck, generationRetirementsCheck } from '../../src/commands/doctor/checks/generations.ts';
import { privacyLabelIgnoredCheck } from '../../src/commands/doctor/checks/privacy-label-ignored.ts';
import type { DoctorContext } from '../../src/commands/doctor/context.ts';
import type { Check } from '../../src/commands/doctor.ts';
import { withEnv } from '../helpers/with-env.ts';

const { parityTest } = parityArms(testBackends());

/** Source ids (legal) that sort `ab, a-x, a-z` by en_US and `a-x, a-z, ab` by byte. */
const SOURCES = ['ab', 'a-z', 'a-x'];
const BYTE_SOURCES = byteOrder(SOURCES);
for (const id of SOURCES) if (!isValidSourceId(id)) throw new Error(`fixture source id ${id} is not a legal source id`);
/** Lower-case reader ids the readable_by normalizer accepts; en_US puts `ab` before `a-z`, bytes put it last. */
const READER_IDS = ['ab', 'a_b', 'a-z', 'a.b'];

const ctx = (engine: BrainEngine, extra: Record<string, unknown> = {}) => ({ engine, progress: { heartbeat() {} }, ...extra }) as unknown as DoctorContext;
type Result = Check & { details?: any };
const first = async (engine: BrainEngine, entry: { run: (c: DoctorContext) => Promise<unknown> }): Promise<Result> => ((await entry.run(ctx(engine))) as Result[])[0]!;

/** One source row; `config` carries its flags (a guest source). Every arm writes it through the harness fixture. */
const insertSource = (engine: BrainEngine, backend: ParityBackend, id: string, config: Record<string, unknown> = {}): Promise<void> =>
  createSource(engine, backend, id, config);

/** One OAuth client row (client id and name are the keys under test), through the typed `insertOauthClient`. */
async function insertClient(engine: BrainEngine, id: string, name: string, extra: Partial<OauthClientInsert> = {}): Promise<void> {
  await engine.insertOauthClient({ client_id: id, client_name: name, scope: 'read', source_id: 'default', federated_read: ['default'], ...extra });
}

/** The attest and may_act_for columns a legacy token takes after its insert, written by the typed credential binding. */
type TokenBinding = { attest_actor?: string; attest_read?: 'scope' | 'person'; may_act_for?: string[] };

/** One legacy token row, named `name`; `set` binds the attest and may_act_for columns afterwards. */
async function insertToken(engine: BrainEngine, name: string, set: TokenBinding = {}): Promise<void> {
  const [token] = await insertUnifiedToken(engine, { name, tokenHash: `hash-${name}`, grant: { sources: { kind: 'default' }, takesHolders: ['world'], allowedOperations: null } });
  if (Object.keys(set).length === 0) return;
  await engine.transaction(tx => tx.writeCredentialBinding({ kind: 'token', id: token!.id },
    { member: null, mayActFor: set.may_act_for ?? null, attestActor: set.attest_actor ?? null, attestOps: null, attestSources: null, attestRead: set.attest_read ?? null }));
}

async function insertPage(engine: BrainEngine, sourceId: string, slug: string, extra: { type?: string; frontmatter?: Record<string, unknown> } = {}): Promise<void> {
  await engine.putPage(slug, { type: (extra.type ?? 'note') as 'note', title: slug, compiled_truth: 'body', timeline: '', frontmatter: extra.frontmatter ?? {} }, { sourceId });
}

/**
 * One live generation of `kind` under `sourceId` that retired one item, and one held generation of the same key: the
 * typed ledger writers the generation publish uses (generations/publish.ts `activateGeneration` and `recordHeld`).
 */
async function insertGenerations(engine: BrainEngine, sourceId: string, kind: string, n: number): Promise<void> {
  const key = { sourceId, kind, ownerKey: 'owner' };
  await engine.transaction(async tx => {
    await tx.activateGenerationRows(key, null, { generation: 1, runId: null, operationId: `op-live-${n}`, inputPin: null, inputSize: null,
      completeness: JSON.stringify({ complete: true }), setHash: 'hash', restoreOf: null, activationId: null, locator: null },
    [{ item_key: 'item', identity_hash: 'identity', action: 'retired', preimage: null, preimage_bytes: null, pending: false }]);
    await tx.recordHeldGenerationRow(key, { holdId: `op-held-${n}`, runId: null, inputPin: null, inputSize: null, setHash: 'hash', reason: 'shrunk',
      context: JSON.stringify({}), proposal: null, proposalBytes: 0 });
  });
}

describe('access doctor checks list their keys by byte', () => {
  parityTest('attest_read_shared_scope lists the credentials by kind, then by byte name', {
    methods: ['insertOauthClient', 'insertAccessToken', 'writeCredentialBinding', 'transaction', 'listAttestCredentialRows'],
  }, async (engine, backend) => {
    await insertClient(engine, 'client-scope', 'scope-reader', { attest_actor: 'qm' });
    await insertToken(engine, 'scope-reader-token', { attest_actor: 'qm' });
    for (const [i, name] of MIXED_IDS.entries()) {
      await insertClient(engine, `client-${i}`, name, { attest_actor: 'qm', attest_read: 'person' });
      await insertToken(engine, name, { attest_actor: 'qm', attest_read: 'person' });
    }
    const check = await first(engine, attestReadAccessEntry);
    const listed = (check.details.credentials as Array<{ kind: string; name: string }>).map(c => `${c.kind}:${c.name}`);
    const expected = [...BYTE_IDS.map(n => `client:${n}`), ...BYTE_IDS.map(n => `token:${n}`)];
    expect(check.status).toBe('warn');
    expect(listed).toEqual(expected);
    expect(check.message).toContain(BYTE_IDS.map(n => `client ${n} (default)`).join('; '));
    return { status: check.status, listed };
  });

  parityTest('access_may_act_for_wildcard lists the wildcard credentials by kind, then by byte name', {
    methods: ['insertOauthClient', 'insertAccessToken', 'writeCredentialBinding', 'transaction', 'setConfig', 'listActiveAccessTokenRows', 'listActiveOauthClientRows', 'readStoredConfigValue'],
  }, async (engine, backend) => {
    for (const [i, name] of MIXED_IDS.entries()) {
      await insertClient(engine, `client-${i}`, name, { may_act_for: ['*'] });
      await insertToken(engine, name, { may_act_for: ['*'] });
    }
    await engine.setConfig('access.restrictions_present', '1');
    const check = await first(engine, sharedAgentAccessEntry);
    const listed = (check.details.credentials as Array<{ kind: string; name: string }>).map(c => `${c.kind}:${c.name}`);
    expect(check.status).toBe('warn');
    expect(listed).toEqual([...BYTE_IDS.map(n => `client:${n}`), ...BYTE_IDS.map(n => `token:${n}`)]);
    expect(check.message).toContain(`: ${BYTE_IDS.map(n => `client ${n}`).join(', ')}. `);
    return { status: check.status, listed };
  });

  parityTest('grant_new_ops_available lists the grants of OAuth clients by byte client id', {
    methods: ['insertOauthClient', 'listActiveOauthClientRows'],
  }, async (engine, backend) => {
    const profile = resolveGrantProfile({ profile: 'memory-writer', sourceId: 'default' });
    const operations = profile.allowedOperations!.filter(op => op !== 'put_pages');
    for (const id of MIXED_IDS) {
      await insertClient(engine, id, `writer ${id}`, { scope: 'read write', surface: 'starter', surface_set_by: 'operator', allowed_operations: operations, grant_profile: 'memory-writer' });
    }
    const check = await checkGrantNewOps(engine, { cfg: { engine: 'pglite' } as never });
    const ids = (check.details!.grants as Array<{ id: string }>).map(g => g.id);
    expect(check.status).toBe('warn');
    expect(ids).toEqual([...BYTE_IDS]);
    return { status: check.status, ids };
  });

  parityTest('unscoped_multi_user_token lists the flagged OAuth clients by byte client id', {
    methods: ['insertOauthClient', 'putPage', 'setConfig', 'listActiveOauthClientRows', 'listActiveAccessTokenRows', 'readChatCensusRows'],
  }, async (engine, backend) => {
    for (const id of MIXED_IDS) await insertClient(engine, id, `reader ${id}`);
    await engine.setConfig('access.serves', 'several');
    for (const channel of ['alpha', 'beta']) await insertPage(engine, 'default', `chats/${channel}`, { type: 'slack', frontmatter: { channel } });
    const home = mkdtempSync(join(tmpdir(), 'collate-doctor-'));
    try {
      const check = await withEnv({ GBRAIN_HOME: home, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude') }, async () =>
        ((await unscopedMultiUserTokenEntry.run(ctx(engine, { args: [] }))) as Result[])[0]!);
      const ids = (check.details.flagged as Array<{ subject: { id?: string } }>).filter(f => f.subject.id).map(f => f.subject.id);
      expect(check.status).toBe('warn');
      expect(ids).toEqual([...BYTE_IDS]);
      return { status: check.status, ids };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  parityTest('oauth_client_scope_health lists dangling grants, orphaned workspaces and privileged clients by byte', {
    methods: ['insertOauthClient', 'listDanglingFederatedReads', 'listOrphanWorkspaceSources', 'listPrivilegedDcrClients'],
  }, async (engine, backend) => {
    const privileged = DCR_PRIVILEGED_SCOPES[0]!;
    for (const id of MIXED_IDS) {
      await insertClient(engine, id, `n-${id}`, { scope: `read ${privileged}`, federated_read: [...MIXED_SLUGS] });
    }
    for (const id of SOURCES) await insertSource(engine, backend, `${id}-workspace`);
    const check = await checkOauthClientScopeHealth(engine);
    const message = check.message;
    expect(check.status).toBe('warn');
    expect(message).toContain(BYTE_IDS.map(id => `"n-${id}" (${id}) scope=read ${privileged}`).join('; '));
    expect(message).toContain(BYTE_IDS.map(id => `"n-${id}" (${id}) → ${BYTE_SLUGS.join(', ')}`).join('; '));
    expect(message).toContain(`: ${BYTE_SOURCES.map(id => `${id}-workspace`).join(', ')}. `);
    return { status: check.status, message };
  });

  parityTest('access_readers_malformed and access_unknown_readers list pages and readers by byte', {
    methods: ['putPage', 'setConfig', 'listMalformedReaderPages', 'listUnknownReaders', 'listRecentReaderNarrowings'],
  }, async (engine, backend) => {
    for (const id of SOURCES) {
      await insertSource(engine, backend, id);
      for (const slug of MIXED_SLUGS) await insertPage(engine, id, slug, { frontmatter: { readable_by: ['!!not valid!!'] } });
    }
    await insertPage(engine, 'default', 'notes/names-readers', { frontmatter: { readable_by: READER_IDS.map(id => `member:${id}`) } });
    await engine.setConfig('access.restrictions_present', '1');
    const checks = Object.fromEntries(((await memberAccessEntry.run(ctx(engine))) as Result[]).map(c => [c.name, c])) as Record<string, Result>;
    const samples = checks.access_readers_malformed!.details.samples as string[];
    const readers = (checks.access_unknown_readers!.details.unknown as Array<{ reader: string }>).map(r => r.reader);
    expect(checks.access_readers_malformed!.status).toBe('warn');
    expect(samples).toEqual(BYTE_SOURCES.flatMap(id => BYTE_SLUGS.map(slug => `${id}:${slug}`)));
    expect(checks.access_unknown_readers!.status).toBe('warn');
    expect(readers).toEqual(byteOrder(READER_IDS.map(id => `member:${id}`)));
    return { samples, readers };
  });

  parityTest('guest_source lists the guest sources by byte id', { methods: ['listGuestSourceRows'] }, async (engine, backend) => {
    for (const id of SOURCES) await insertSource(engine, backend, id, { guest: true });
    const check = await guestSourceCheck(engine);
    const ids = (check.details!.sources as Array<{ source: string }>).map(s => s.source);
    expect(check.status).toBe('fail');
    expect(ids).toEqual(BYTE_SOURCES);
    expect(check.message).toContain(`Guest source(s) ${BYTE_SOURCES.join(', ')}: `);
    return { status: check.status, ids };
  });

  parityTest('access_policy_pending lists the sources with pending prefixes by byte id', {
    methods: ['countAccessFolderDrift'],
  }, async (engine, backend) => {
    for (const id of SOURCES) await insertSource(engine, backend, id);
    for (const id of SOURCES) await restrictFolder(engine, backend, id, 'hr/', 'pending');
    const check = ((await folderAccessEntry.run(ctx(engine))) as Result[]).find(c => c.name === 'access_policy_pending')!;
    const sources = (check.details.sources as Array<{ source: string }>).map(s => s.source);
    expect(check.status).toBe('warn');
    expect(sources).toEqual(BYTE_SOURCES);
    expect(check.message).toContain(BYTE_SOURCES.map(id => `${id} (pending: hr/)`).join('; '));
    return { status: check.status, sources };
  });

  parityTest('storage_manifest lists the sources with interim records by byte id', {
    methods: ['putPage'],
  }, async (engine, backend) => {
    for (const id of SOURCES) {
      await insertSource(engine, backend, id);
      await insertPage(engine, id, 'storage-manifest/dataset-a', { type: 'stored-object' });
    }
    const check = await storageManifestCheck(engine);
    const sources = (check.details!.interim_pending as Array<{ source_id: string }>).map(r => r.source_id);
    expect(check.status).toBe('warn');
    expect(sources).toEqual(BYTE_SOURCES);
    expect(check.message).toContain(BYTE_SOURCES.map(id => `${id}: 1`).join(', '));
    return { status: check.status, sources };
  });

  parityTest('generation_retirements and generation_held list sources and kinds by byte', {
    methods: ['transaction', 'activateGenerationRows', 'recordHeldGenerationRow', 'listLiveGenerationRetirements', 'listHeldGenerations'],
  }, async (engine, backend) => {
    const kinds = ['kb', 'k-z', 'k-x'];
    let n = 0;
    for (const id of SOURCES) {
      await insertSource(engine, backend, id);
      for (const kind of kinds) await insertGenerations(engine, id, kind, n += 1);
    }
    const retired = await generationRetirementsCheck(engine, [...SOURCES]);
    const held = await generationHeldCheck(engine, [...SOURCES]);
    const keys = (rows: Array<{ source_id: string; kind: string }>) => rows.map(r => `${r.source_id}/${r.kind}`);
    const expected = BYTE_SOURCES.flatMap(id => byteOrder(kinds).map(kind => `${id}/${kind}`));
    expect(retired.details!.by_source as unknown[]).toHaveLength(9);
    expect(keys(retired.details!.by_source as never)).toEqual(expected);
    expect(retired.message).toContain(expected.map(k => `${k}: 1`).join('; '));
    expect(held.status).toBe('warn');
    expect(keys(held.details!.by_reason as never)).toEqual(expected);
    expect(held.message).toContain(expected.map(k => `${k} shrunk: 1`).join('; '));
    return { retired: keys(retired.details!.by_source as never), held: keys(held.details!.by_reason as never) };
  });

  parityTest('privacy_label_ignored lists the label values by byte', { methods: ['putPage'] }, async (engine, backend) => {
    const values = MIXED_SLUGS.map(s => `personal ${s}`);
    for (const [i, value] of values.entries()) await insertPage(engine, 'default', `notes/label-${i}`, { frontmatter: { access: value } });
    const check = await privacyLabelIgnoredCheck(engine);
    const listed = (check.details!.values as Array<{ value: string }>).map(v => v.value);
    expect(check.status).toBe('warn');
    expect(listed).toEqual(byteOrder(values));
    return { status: check.status, listed };
  });
});
