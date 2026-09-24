import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { publishMutation, recoverPublication, type PreparedMutation } from '../../src/core/persistence/coordinator.ts';
import { sha256 } from '../../src/core/persistence/digest.ts';
import { localHostId, registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { admitWrite, claimNextWrite, getWriteRequestById, type WriteAdmission } from '../../src/core/persistence/journal.ts';
import { claimWorktree, getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../../src/core/persistence/skill-activation.ts';
import { SHARED_SKILLS_PERSISTENCE_SCHEMA_STATEMENTS } from '../../src/core/shared-skills/persistence-schema.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const [mode, configPath, name, boundary = ''] = process.argv.slice(2);
const config: GBrainConfig & { root: string; sourceId: string } = JSON.parse(readFileSync(configPath, 'utf8'));
if (config.engine === 'postgres') assertSafeE2eDatabaseUrl(config.database_url!);
const engine = config.engine === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
await engine.connect(config);
const emit = (value: Record<string, unknown>) => writeSync(1, JSON.stringify(value) + '\n');
const stop = (point: string, id: string): void => {
  if (point !== boundary) return;
  emit({ boundary: point, id });
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (;;) Atomics.wait(wait, 0, 0);
};

try {
  if (mode === 'initialize') {
    await engine.initSchema();
    for (const statement of SHARED_SKILLS_PERSISTENCE_SCHEMA_STATEMENTS) await engine.executeRaw(statement);
    mkdirSync(config.root, { recursive: true });
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [config.sourceId, config.root]);
    await registerLocalWriter(engine, 'cli'); await registerLocalWriter(engine, 'stdio');
    await claimWorktree(engine, config.sourceId, config.root);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    await engine.executeRaw('CREATE TABLE bundle_crash_projection (name text PRIMARY KEY,revision uuid NOT NULL)');
    emit({ initialized: true });
  } else {
    const binding = (await getWorktreeBinding(engine, config.sourceId))!;
    const root = join(config.root, 'skills', name);
    const paths = ['SKILL.md', 'helper.txt', 'obsolete.txt'].map(file => join(root, file));
    const authority = await submissionAuthority({ engine, config, sourceId: config.sourceId, remote: false,
      dryRun: false, logger: { info() {}, warn() {}, error() {} } }, 'put_skill', config.sourceId, binding.source_incarnation, name);
    const [existing] = await engine.executeRaw<{ id: string; request_id: string }>('SELECT id,request_id FROM persistence_requests WHERE slug=$1', [name]);
    const admission: WriteAdmission = { principal: authority.principal, operation: 'put_skill', targetKind: 'skill_bundle', protocolVersion: 2,
      sourceId: config.sourceId, sourceIncarnation: binding.source_incarnation, slug: name, worktreeId: binding.worktree_id,
      topologyGeneration: binding.topology_generation, requestId: existing?.request_id ?? randomUUID(), callerIntent: { name }, intent: { name }, authority };
    const prepared: PreparedMutation = { target: 'skill_bundle', observedRevision: null,
      files: paths.map((path, index) => ({ path, root: config.root, content: index === 2 ? null : `new-${index}`,
        expectedBeforeHash: index === 1 ? null : sha256(`old-${index}`) })),
      validate: async tx => {
        const [head] = await tx.executeRaw('SELECT name FROM bundle_crash_projection WHERE name=$1 FOR UPDATE', [name]);
        assert.equal(head, undefined);
      },
      apply: async tx => {
        const revision = randomUUID();
        await tx.executeRaw('INSERT INTO bundle_crash_projection(name,revision) VALUES($1,$2::uuid)', [name, revision]);
        return { revision };
      },
    };
    if (mode === 'publish' || mode === 'admit') {
      mkdirSync(root, { recursive: true });
      writeFileSync(paths[0], 'old-0'); writeFileSync(paths[2], 'old-2');
      const admitted = await admitWrite(engine, admission);
      if (mode === 'admit') emit({ admitted: true, id: admitted.id });
      else {
        const row = (await claimNextWrite(engine, localHostId()))!;
        assert.equal(row.id, admitted.id);
        await publishMutation(engine, row, prepared, localHostId(), {
          boundary: async point => { stop(point, row.id); },
          fileBoundary: (point, _request, index) => stop(`${point}:${index}`, row.id),
        });
        throw new Error('fixture publication did not reach requested crash boundary');
      }
    } else if (mode === 'preactivation-fixture') {
      await engine.transaction(async tx => {
        await tx.executeRaw('ALTER TABLE persistence_brain DISABLE TRIGGER gbrain_protocol_activation');
        await tx.executeRaw('UPDATE persistence_brain SET writer_protocol_floor=1,skill_bundles_enabled=false WHERE singleton=1');
        await tx.executeRaw('ALTER TABLE persistence_brain ENABLE TRIGGER gbrain_protocol_activation');
      });
      emit({ protocol_floor: 1 });
    } else if (mode === 'inspect') {
      const row = (await getWriteRequestById(engine, existing.id))!;
      emit({ state: row.state, execution_token: row.execution_token, recovery: row.recovery,
        files: paths.map(path => existsSync(path) ? readFileSync(path, 'utf8') : null) });
    } else {
      let row = (await getWriteRequestById(engine, existing.id))!;
      const initiallyCommitted = row.state === 'committed';
      row = await recoverPublication(engine, row.id, localHostId(), false, undefined, false,
        { fileBoundary: (point, _request, index) => stop(`${point}:${index}`, row.id) });
      if (!initiallyCommitted) {
        assert.equal(row.state, 'queued');
        assert.equal(readFileSync(paths[0], 'utf8'), 'old-0');
        assert.equal(existsSync(paths[1]), false);
        assert.equal(readFileSync(paths[2], 'utf8'), 'old-2');
        const claimed = (await claimNextWrite(engine, localHostId()))!;
        assert.equal(claimed.id, row.id);
        row = await publishMutation(engine, claimed, prepared, localHostId());
      }
      assert.equal(row.state, 'committed');
      assert.equal(readFileSync(paths[0], 'utf8'), 'new-0');
      assert.equal(readFileSync(paths[1], 'utf8'), 'new-1');
      assert.equal(existsSync(paths[2]), false);
      const replay = await admitWrite(engine, admission);
      assert.equal(replay.id, row.id); assert.deepEqual(replay.outcome, row.outcome);
      assert.equal((await getWriteRequestById(engine, row.id))!.recovery, null);
      const [counter] = await engine.executeRaw<{ bytes: string }>("SELECT recovery_bytes::text AS bytes FROM persistence_counters WHERE key='brain'");
      assert.equal(Number(counter.bytes), 0);
      const [heads] = await engine.executeRaw<{ count: number }>('SELECT count(*)::integer AS count FROM bundle_crash_projection WHERE name=$1', [name]);
      assert.equal(heads.count, 1);
      emit({ committed: true, replay_preserved: true, recovery_bytes: 0, initiallyCommitted });
    }
  }
} finally { await engine.disconnect(); }
