import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { registerLocalWriter, localHostId } from '../../src/core/persistence/identity.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { admitWrite, completeWrite } from '../../src/core/persistence/journal.ts';
import { recordFactWithdrawal } from '../../src/core/facts/withdrawal.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { renderFactsTable, parseFactsFence } from '../../src/core/facts-fence.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { assertSafeE2eDatabaseUrl } from './db-guard.ts';

const [mode, backend, root, database, boundary] = process.argv.slice(2);
if (backend === 'postgres') assertSafeE2eDatabaseUrl(database);
const engine = backend === 'pglite' ? new PGLiteEngine() : new PostgresEngine();
await engine.connect(backend === 'pglite' ? { database_path: database } : { database_url: database });
const hostId = localHostId(), sourceId = 'synthetic-withdrawal-crash';
try {
  if (mode === 'seed') {
    await engine.initSchema(); await registerLocalWriter(engine, 'cli');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
    const binding = await claimWorktree(engine, sourceId, root, hostId);
    for (const slug of ['affected', 'untouched']) {
      const body = slug === 'affected' ? renderFactsTable([{ rowNum: 1, claim: 'synthetic crash claim', kind: 'fact', confidence: 1,
        visibility: 'world', notability: 'medium', active: true }]) : 'Exact untouched bytes';
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body }, { sourceId });
      await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: body }], { sourceId });
      const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
      writeFileSync(join(root, `${slug}.md`), serializePageToMarkdown(snapshot.page, snapshot.tags));
    }
    const fact = await engine.insertFact({ fact: 'synthetic crash claim', source: 'synthetic', visibility: 'world' }, { source_id: sourceId });
    const context: OperationContext = { engine, remote: false, sourceId, config: { engine: engine.kind }, dryRun: false,
      logger: { info() {}, warn() {}, error() {} } };
    const authority = await submissionAuthority(context, 'forget', sourceId, binding.source_incarnation, 'affected');
    const request = await admitWrite(engine, { authority, principal: authority.principal, operation: 'forget', sourceId,
      sourceIncarnation: binding.source_incarnation, slug: 'affected', pageId: null, requestId: randomUUID(),
      intent: { id: fact.id }, callerIntent: { id: fact.id }, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
    const untouched = await engine.executeRaw(`SELECT row_to_json(p) AS page,(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id)
      FROM content_chunks c WHERE c.page_id=p.id) AS chunks FROM pages p WHERE source_id=$1 AND slug='untouched'`, [sourceId]);
    await engine.transaction(async tx => {
      await recordFactWithdrawal(tx, fact.id, sourceId, false, { requestId: request.id });
      await completeWrite(tx, request, 'committed', { status: 'forgotten' });
    });
    const revision = (await engine.readPageSnapshot('affected', { sourceId }))!.revision;
    writeFileSync(join(root, 'state.json'), JSON.stringify({ untouched, revision, requestId: request.id, bytes: readFileSync(join(root, 'untouched.md'), 'base64') }));
  } else if (mode === 'crash') {
    await runPersistenceEffects(engine, { engine: backend as 'pglite' | 'postgres', embedding_disabled: true }, { hostId, limit: 1,
      boundary: async name => {
        if (name === boundary) { console.log('AT_MIRROR_BOUNDARY'); await new Promise(() => {}); }
      } });
    throw new Error('Did not reach the requested mirror boundary');
  } else {
    const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
    await engine.executeRaw('UPDATE persistence_effects SET next_attempt_at=now() WHERE request_id=$1::uuid', [state.requestId]);
    await runPersistenceEffects(engine, { engine: backend as 'pglite' | 'postgres', embedding_disabled: true }, { hostId, limit: 3 });
    const untouched = await engine.executeRaw(`SELECT row_to_json(p) AS page,(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id)
      FROM content_chunks c WHERE c.page_id=p.id) AS chunks FROM pages p WHERE source_id=$1 AND slug='untouched'`, [sourceId]);
    const snapshot = (await engine.readPageSnapshot('affected', { sourceId }))!;
    const recovery = await engine.executeRaw('SELECT id FROM persistence_effects WHERE request_id=$1::uuid AND recovery IS NOT NULL', [state.requestId]);
    if (JSON.stringify(untouched) !== JSON.stringify(state.untouched) || readFileSync(join(root, 'untouched.md'), 'base64') !== state.bytes ||
      snapshot.revision !== state.revision || !parseFactsFence(readFileSync(join(root, 'affected.md'), 'utf8')).facts[0].forgotten || recovery.length) {
      throw new Error('Native crash recovery violated canonical invariants');
    }
    console.log('RECOVERED_EXACTLY');
  }
} finally { await engine.disconnect(); }
