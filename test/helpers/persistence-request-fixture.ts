import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { registerLocalWriter, localHostId } from '../../src/core/persistence/identity.ts';
import { admitWrite, claimNextWrite } from '../../src/core/persistence/journal.ts';
import { publishMutation } from '../../src/core/persistence/coordinator.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';

/** A database-only source with directly admitted and published put_page requests, bypassing operation handlers. */
export async function requestFixture(engine: BrainEngine, sourceId = `requests-${randomUUID()}`) {
  await registerLocalWriter(engine, 'cli');
  const [source] = await engine.executeRaw<{ incarnation: string }>(
    'INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name RETURNING incarnation', [sourceId]);
  const ctx: OperationContext = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId,
    logger: { info() {}, warn() {}, error() {} } };
  const admit = async (slug = 'page', requestId = randomUUID(), binding?: { worktree_id: string; topology_generation: string | number }) => {
    const authority = await submissionAuthority(ctx, 'put_page', sourceId, source.incarnation, slug);
    return admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId, sourceIncarnation: source.incarnation,
      slug, requestId, callerIntent: { body: slug }, intent: { body: slug },
      ...(binding ? { worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation } : {}) });
  };
  const publish = async (admitted: WriteRequest) => {
    const row = (await claimNextWrite(engine, localHostId()))!;
    if (row.id !== admitted.id) throw new Error('fixture expected the admitted request at the head of its queue');
    return publishMutation(engine, row, { observedRevision: null, apply: async tx => {
      await tx.putPage(row.slug, { type: 'note', title: 'Example', compiled_truth: row.slug, timeline: '', frontmatter: {} }, { sourceId });
      return {};
    } }, localHostId());
  };
  return { sourceId, incarnation: source.incarnation, ctx, admit, publish };
}

/** Row edits that simulate older binaries or elapsed time; the request trigger requires the protocol declaration. */
export async function editRequest(engine: BrainEngine, id: string, assignments: string, params: unknown[] = []) {
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw(`UPDATE persistence_requests SET ${assignments} WHERE id=$1::uuid`, [id, ...params]);
  });
}
export async function readRequest(engine: BrainEngine, id: string) {
  const [row] = await engine.executeRaw<Record<string, unknown>>(`SELECT state,admitter_version,admitter_host_id::text AS admitter_host_id,
    consumer_version,consumer_host_id::text AS consumer_host_id,published_at,completed_at,compacted FROM persistence_requests WHERE id=$1::uuid`, [id]);
  return row;
}

/**
 * One migrated brain per test: PGLite resets its shared engine, PostgreSQL clones a migrated template
 * database (CREATE DATABASE ... TEMPLATE), so brain-wide checks never see another test's requests.
 */
export async function freshBrainFactory(kind: 'pglite' | 'postgres', databaseUrl?: string) {
  if (kind === 'pglite') {
    const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
    const { resetPgliteState } = await import('./reset-pglite.ts');
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    const version = (await engine.getConfig('version'))!;
    return {
      fresh: async () => { await resetPgliteState(engine); await engine.setConfig('version', version); return engine as BrainEngine; },
      dispose: () => engine.disconnect(),
    };
  }
  const { default: postgres } = await import('#postgres');
  const { PostgresEngine } = await import('../../src/core/postgres-engine.ts');
  const { isolatedPersistencePostgres } = await import('./persistence-postgres.ts');
  const template = await isolatedPersistencePostgres(databaseUrl!);
  const [row] = await template.engine.executeRaw<{ name: string }>('SELECT current_database() AS name');
  await template.engine.disconnect();
  const admin = postgres(databaseUrl!, { max: 1, prepare: false });
  const created: string[] = [];
  let current: BrainEngine | undefined;
  return {
    fresh: async () => {
      await current?.disconnect();
      const name = `${row.name}_${created.length}`;
      await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE ${row.name}`);
      created.push(name);
      const url = new URL(databaseUrl!); url.pathname = `/${name}`;
      const engine = new PostgresEngine();
      await engine.connect({ database_url: url.toString(), poolSize: 4 });
      current = engine;
      return engine as BrainEngine;
    },
    dispose: async () => {
      await current?.disconnect();
      for (const name of created) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.unsafe(`DROP DATABASE IF EXISTS ${row.name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
