/**
 * BrainEngine parity — the reviewed shared-skill activation and the canonical pack adoption the v0.53.0 migration runs
 * (persistence/skill-activation.ts, shared-skills/publication.ts adoptSharedSkillpack).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: activation with the writer admin state a reviewed status printed passes; a stale state refuses
 *    writer_admin_state_changed and leaves the admin state as it was. After activation, adopting a brain-resident
 *    pack from the source's canonical root commits it, and the sealed pack row (readSharedSkillPackRow) and the live
 *    source (readSourceIncarnationArchived) that adoption reads give the same answers on every engine arm (PGLite
 *    always; Postgres with DATABASE_URL; the Rust arm through test/engine-parity/harness.ts).
 *  - Regression: on a Rust brain a reviewed activation refused engine_capability_missing, and adoptSharedSkillpack
 *    refused engine_capability_missing before it read anything (its source and pack reads were raw SQL).
 *  - Why existing coverage misses it: shared-skill-members.test.ts activates without a reviewed state and publishes
 *    one skill with put_skill; no parity case adopted a pack.
 *  - Seam: GBRAIN_HOME through withEnv (the local writer registration lives under it). Generated values (ids,
 *    revisions, timestamps) are reduced to their shape in the returned values.
 */
import { describe, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { registerServeLocalWriters } from '../../src/core/persistence/provider.ts';
import { activatePersistence } from '../../src/core/persistence/activation.ts';
import { activateSharedSkillPersistence } from '../../src/core/persistence/skill-activation.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { setSharedSkillPolicy } from '../../src/core/shared-skills/policy.ts';
import { adoptSharedSkillpack } from '../../src/core/shared-skills/publication.ts';
import { LATEST_VERSION } from '../../src/core/migrate.ts';

const { parityTest } = parityArms(testBackends());

const BODY = '---\nname: notes\ndescription: Take notes.\n---\nTake notes.\n';
const MANIFEST = `${JSON.stringify({ name: 'pack', brain_resident: true, skills: ['skills/notes'] }, null, 2)}\n`;
const POLICY = { version: 1 as const, enabled: true, classes: ['prose' as const], audiences: ['readers'], requirements: [], allow_follow: true };

async function inFreshHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-skill-adoption-'));
  try { return await withEnv({ GBRAIN_HOME: home }, fn); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

function local(engine: BrainEngine): OperationContext {
  return { engine, config: { engine: engine.kind }, remote: false, dryRun: false,
    logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
}

/** Fixture: the arm reset empties the singletons a brain gets at schema install; put them back. */
async function installSingletons(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  if (backend === 'rust') return;
  await engine.executeRaw('INSERT INTO trust_policy_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
  await engine.executeRaw('INSERT INTO shared_skill_state(singleton) VALUES(1) ON CONFLICT DO NOTHING');
}

/**
 * Fixture: the default source at a temp canonical root. A SQL arm claims the root as this host's worktree and turns
 * managed persistence on (the reviewed shared-skill activation needs it there); a Rust brain has neither, so its root
 * is the source's registered path.
 */
async function withCanonicalRoot<T>(engine: BrainEngine, backend: ParityBackend, fn: (root: string) => Promise<T>): Promise<T> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-parity-adoption-root-')));
  try {
    await engine.attachSourcePath('default', root);
    if (backend !== 'rust') {
      await engine.setConfig('version', String(LATEST_VERSION));
      await claimWorktree(engine, 'default', root);
    }
    await installSingletons(engine, backend);
    await registerServeLocalWriters(engine);
    if (backend !== 'rust') await activatePersistence(engine, { confirmQuiesced: true });
    return await fn(root);
  } finally {
    await disposePersistenceConsumer(engine);
    if (backend !== 'rust') await engine.transaction(async tx => {
      await tx.executeRaw('SET LOCAL session_replication_role = replica');
      await tx.executeRaw('UPDATE persistence_brain SET skill_bundles_enabled=false, writer_protocol_floor=1, enabled=false WHERE singleton=1');
    });
    rmSync(root, { recursive: true, force: true });
  }
}

/** The answer of `run`, or its refusal reduced to the code and the message. */
async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try { return { ok: await run() }; }
  catch (error) { const e = error as { code?: string; message?: string }; return { code: e.code, message: e.message }; }
}

/** Ids, revisions and timestamps reduced to their shape. */
function generic(value: unknown): unknown {
  if (typeof value === 'string') {
    return /^\d{4}-\d{2}-\d{2}T/.test(value) ? '<date>' : value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');
  }
  if (value instanceof Date) return '<date>';
  if (Array.isArray(value)) return value.map(generic);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, generic(inner)]));
  return value;
}

describe('engine parity: reviewed shared-skill activation and canonical pack adoption', () => {
  parityTest('a reviewed admin state activates shared publication; a stale one refuses writer_admin_state_changed and changes nothing', {
    methods: ['readWriterAdminState', 'transaction'],
  }, (engine, backend) => inFreshHome(() => withCanonicalRoot(engine, backend, async () => {
    const before = await writerAdminState(engine);
    const stale = await outcome(() => activateSharedSkillPersistence(engine, { confirmQuiesced: true, expectedState: '0'.repeat(64) }));
    const unchanged = await writerAdminState(engine) === before;
    const reviewed = await outcome(() => activateSharedSkillPersistence(engine, { confirmQuiesced: true, expectedState: before }));
    const ok = (reviewed as { ok?: Record<string, unknown> }).ok;
    const result = { stale, unchanged, reviewed: ok ? { activated: ok.activated, protocol_version: ok.protocol_version, filesystem_sources: ok.filesystem_sources } : reviewed };
    expect(result.stale).toMatchObject({ code: 'writer_admin_state_changed' });
    expect(result.unchanged).toBe(true);
    expect(result.reviewed).toEqual({ activated: true, protocol_version: 2, filesystem_sources: 1 });
    return result;
  })));

  parityTest('after activation a brain-resident pack adopts from the canonical root; the pack row and live source it reads agree', {
    methods: ['readSharedSkillPackRow', 'readSourceIncarnationArchived', 'readSharedSkillPolicyRow', 'writeSharedSkillPolicy',
      'writeSharedSkillRevision', 'transaction'],
  }, (engine, backend) => inFreshHome(() => withCanonicalRoot(engine, backend, async (root) => {
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    await engine.setConfig('mcp.publish_skills', 'true');
    const source = (await engine.readSourceIncarnationArchived('default'))!;
    await setSharedSkillPolicy(local(engine), 'default', POLICY, null);
    mkdirSync(join(root, 'skills', 'notes'), { recursive: true });
    writeFileSync(join(root, 'skills', 'notes', 'SKILL.md'), BODY);
    writeFileSync(join(root, 'skillpack.json'), MANIFEST);
    const before = await engine.readSharedSkillPackRow('default', source.incarnation) ?? null;
    const adopted = await adoptSharedSkillpack(local(engine), 'default');
    const pack = await engine.readSharedSkillPackRow('default', source.incarnation);
    const result = {
      source: { archived: source.archived, incarnation: generic(source.incarnation) },
      before,
      receipts: adopted.receipts.map(receipt => {
        const r = receipt as { status?: string; state?: string; delivery?: string; name?: string; pack_id?: string };
        return { status: r.status, state: r.state, delivery: r.delivery, name: r.name, pack_id: r.pack_id };
      }),
      pack: pack ? { pack_id: pack.pack_id, revision: generic(pack.revision), manifest_keys: Object.keys(pack.manifest).sort(), manifest_hash_is_hex: /^[0-9a-f]{64}$/.test(pack.manifest_hash) } : null,
      missing: await engine.readSharedSkillPackRow('missing', source.incarnation) ?? null,
    };
    expect(result.before).toBeNull();
    expect(result.receipts).toEqual([{ status: 'published', state: 'committed', delivery: 'canonical_committed', name: 'notes', pack_id: 'pack' }]);
    expect(result.pack).toMatchObject({ pack_id: 'pack', revision: '<uuid>', manifest_hash_is_hex: true });
    expect(result.missing).toBeNull();
    return result;
  })));
});
