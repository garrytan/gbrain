import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { loadConfig, toEngineConfig } from '../../src/core/config.ts';
import { configureGateway } from '../../src/core/ai/gateway.ts';
import { buildGatewayConfig } from '../../src/core/ai/build-gateway-config.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';

const action = process.argv[2];
const home = process.env.GBRAIN_HOME!;
const config = loadConfig()!;
configureGateway(buildGatewayConfig(config));
const engine = new PGLiteEngine();
await engine.connect(toEngineConfig(config));
try {
  await engine.initSchema();
  if (action === 'seed') {
    const root = join(home, 'repo');
    const slug = 'documents/2026-09-22-example';
    await engine.setConfig('version', '162');
    await engine.setConfig('models.dream.extract_atoms', 'anthropic:claude-haiku-4-5');
    await engine.setConfig('cycle.extract_atoms.budget_usd', '1');
    await engine.setConfig('sync.repo_path', root);
    await engine.setConfig('facts.extraction_enabled', 'false');
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
    await engine.putPage(slug, { type: 'source', title: 'CLI example source',
      compiled_truth: 'A synthetic project source requires measured delivery criteria before rollout. '.repeat(40).trim(), frontmatter: { visibility: 'private' } }, { sourceId: 'default' });
    const file = join(root, `${slug}.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, serializePageToMarkdown((await engine.getPage(slug, { sourceId: 'default' }))!, []));
    await registerLocalWriter(engine, 'cli');
    await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'default', path: root, admin_intent: 'writer_claim', expected_state: await writerAdminState(engine) });
    await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, admin_intent: 'writer_activate', expected_state: await writerAdminState(engine) });
  }
  if (action === 'hold') {
    const [brain] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
    process.send?.({ ready: true, enabled: brain.enabled });
    await new Promise<void>(resolve => {
      process.on('message', message => { if (message === 'stop') resolve(); });
      process.once('SIGTERM', () => resolve());
    });
  } else {
    const [brain] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
    const atoms = await engine.executeRaw<{ slug: string; visibility: string }>("SELECT slug,frontmatter->>'visibility' AS visibility FROM pages WHERE source_id='default' AND type='atom' AND deleted_at IS NULL");
    const chunks = await engine.executeRaw<{ count: number }>("SELECT count(*)::integer AS count FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id='default' AND p.type='atom'");
    const receipts = await engine.executeRaw<{ request_id: string; state: string; slug: string; outcome: Record<string, unknown> }>("SELECT request_id,state,slug,outcome FROM persistence_requests WHERE operation='submit_job' ORDER BY sequence");
    const search = await engine.searchKeyword('lampreyfixture', { sourceId: 'default', limit: 10 });
    const [pending] = await engine.executeRaw<{ count: number }>("SELECT count(*)::integer AS count FROM persistence_requests WHERE state IN ('queued','running','recovering')");
    const [leases] = await engine.executeRaw<{ count: number }>('SELECT count(*)::integer AS count FROM gbrain_cycle_locks');
    const files = atoms.map(atom => ({ slug: atom.slug, content: readFileSync(join(home, 'repo', `${atom.slug}.md`), 'utf8') }));
    console.log(`FIXTURE_RESULT ${JSON.stringify({ enabled: brain.enabled, atoms, chunks: chunks[0].count, receipts,
      searchSlugs: search.map(result => result.slug), pending: pending.count, leases: leases.count, files })}`);
  }
} finally { await engine.disconnect(); }
process.exit(0);
