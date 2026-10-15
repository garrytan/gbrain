/**
 * Opt-in live smoke: synthetic pages in a new database, deleted on completion.
 * HYDRA_DB_API_KEY=... [HYDRA_DB_BASE_URL=https://api-v2-go.staging.hydradb.com]
 * bun evals/cloud-memory/smoke.ts
 * Does not read an existing brain or need an embedding-provider key.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

if (!process.env.HYDRA_DB_API_KEY) throw new Error('Set HYDRA_DB_API_KEY before running this opt-in smoke.');
const scratch = mkdtempSync(join(tmpdir(), 'gbrain-cloud-smoke-'));
process.env.GBRAIN_HOME = scratch;
process.env.GBRAIN_NON_INTERACTIVE = '1';
process.env.GSTACK_STATE_ROOT = join(scratch, 'gstack');
const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
const { submitPageMutation } = await import('../../src/core/persistence/page-mutations.ts');
const { runCloud } = await import('../../src/commands/cloud.ts');
const { handleToolCall } = await import('../../src/mcp/server.ts');
const { dispatchToolCall } = await import('../../src/mcp/dispatch.ts');
const { unpackToolResult } = await import('../../src/core/mcp-client.ts');
const { HYDRADB_CONFIG, hydraRequest, resolveHydraConnection } = await import('../../src/core/hydradb.ts');
const { mirrorBrain } = await import('../../src/core/hydradb-mirror.ts');
const { drainAllBackgroundWorkForCliExit } = await import('../../src/core/background-work.ts');
const { currentExitCode } = await import('../../src/core/cli-force-exit.ts');
const a = new PGLiteEngine(), b = new PGLiteEngine();
const database = `gbrain_smoke_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const source = 'cloud-smoke';
const sentence = 'The cobalt widget deployment is scheduled for Thursday in the lunar sandbox.';
const logger = { info() {}, warn() {}, error() {} };
const write = async (slug: string, body: string, extra = '') => {
  const existing = await a.getPage(slug, { sourceId: source });
  return submitPageMutation({ engine: a, config: { engine: 'pglite', embedding_disabled: true },
  remote: false, sourceId: source, dryRun: false, logger }, { operation: 'put_page', params: {
    source_id: source, slug, ...(existing?.knowledge_revision ? { expected_revision: existing.knowledge_revision } : {}), content: `---\ntype: note\ntitle: Synthetic deployment\n${extra}---\n${body}\n`,
  } });
};
const checks: string[] = [];
let connected = false;
try {
  for (const engine of [a, b]) {
    await engine.connect({}); await engine.initSchema();
    await engine.setConfig('embedding_disabled', 'true');
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [source]);
  }
  await write('notes/deployment', sentence);
  await write('notes/private', 'A private synthetic canary must never leave this brain.', 'visibility: private\n');
  await a.executeRaw("UPDATE pages SET updated_at = now() - interval '1 minute'");
  await runCloud(a, ['connect', '--yes', '--database', database, '--api-url', process.env.HYDRA_DB_BASE_URL ?? 'https://api.hydradb.com']);
  connected = !!await a.getConfig(HYDRADB_CONFIG.database);
  assert.equal(currentExitCode(), 0, 'connect succeeds');
  const conn = await resolveHydraConnection(a);
  assert.ok(conn);
  checks.push('connect and indexed backfill');
  for (const key of [HYDRADB_CONFIG.database, HYDRADB_CONFIG.primary, HYDRADB_CONFIG.baseUrl]) {
    const value = await a.getConfig(key); if (value) await b.setConfig(key, value);
  }
  for (const op of ['query', 'search', 'recall']) {
    const params = op === 'query' ? { expand: false } : {};
    const result = await handleToolCall(b, op, { query: 'When is the cobalt widget deployment scheduled?', source_id: source, limit: 8, ...params });
    assert.ok(JSON.stringify(result).includes('Thursday'), `${op} retrieves cloud-only memory without local embeddings`);
    assert.ok(!JSON.stringify(result).includes('private synthetic canary'), `${op} excludes private memory`);
    checks.push(`${op} on a second keyless brain`);
  }
  for (const mode of ['fast', 'thinking']) {
    await runCloud(b, ['mode', mode]);
    const markdown = await dispatchToolCall(b, 'query', { query: 'When is the cobalt widget deployment scheduled?', source_id: source, expand: false, limit: 8 },
      { remote: false, transport: 'stdio', sourceId: source, config: { engine: 'pglite' } as never, logger });
    const meta = markdown._meta?.retrieval as { backend?: string; hydradb_mode?: string } | undefined;
    assert.equal(meta?.backend, 'hydradb', `${mode} must use cloud rather than local fallback`);
    assert.equal(meta?.hydradb_mode, mode);
    assert.ok(markdown.content[0]?.text.includes('Thursday'), `${mode} returns readable Markdown`);
    assert.ok(!markdown.content[0]?.text.startsWith('[{'), `${mode} returns text rather than a chunk JSON array`);
    assert.ok(Array.isArray(unpackToolResult(markdown)), 'structured results are available');
    checks.push(`${mode} Markdown and structured MCP output`);
  }
  await runCloud(b, ['mode', 'fast']);
  const paged = await handleToolCall(b, 'query', { query: 'cobalt widget deployment', source_id: source, expand: false, types: ['note'], limit: 8 });
  assert.ok(JSON.stringify(paged).includes('Thursday'), 'type-filtered query still uses HydraDB');
  checks.push('filtered cloud query');
  if (process.env.GBRAIN_GSTACK_ROOT) {
    const { saveConfig } = await import('../../src/core/config.ts');
    const c = new PGLiteEngine();
    const dbPath = join(scratch, 'cli-brain');
    await c.connect({ database_path: dbPath }); await c.initSchema();
    await c.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [source]);
    await c.setConfig('sources.default', source);
    await c.setConfig('embedding_disabled', 'true');
    for (const key of [HYDRADB_CONFIG.database, HYDRADB_CONFIG.primary, HYDRADB_CONFIG.baseUrl]) {
      const value = await a.getConfig(key); if (value) await c.setConfig(key, value);
    }
    await c.disconnect();
    saveConfig({ engine: 'pglite', database_path: dbPath, embedding_disabled: true });
    const binDir = join(scratch, 'bin'); mkdirSync(binDir);
    const quote = (text: string) => "'" + text.replace(/'/g, "'\\''") + "'";
    writeFileSync(join(binDir, 'gbrain'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(import.meta.dir, '../../src/cli.ts'))} "$@"\n`, { mode: 0o700 });
    const skillPath = join(scratch, 'SKILL.md');
    writeFileSync(skillPath, '---\nname: cloud-smoke\ngbrain:\n  schema: 1\n  context_queries:\n    - id: deployment\n      kind: vector\n      query: "When is the cobalt widget deployment scheduled?"\n      render_as: "Deployment memory"\n      limit: 8\n---\nSynthetic skill.\n');
    const result = Bun.spawnSync([process.execPath, join(process.env.GBRAIN_GSTACK_ROOT, 'bin/gstack-brain-context-load.ts'), '--skill-file', skillPath, '--explain'],
      { env: { ...process.env, PATH: binDir + ':' + process.env.PATH, GSTACK_BRAIN_TIMEOUT_MS: '10000', GBRAIN_SOURCE: source }, stdout: 'pipe', stderr: 'pipe' });
    assert.equal(result.exitCode, 0, new TextDecoder().decode(result.stderr));
    assert.ok(new TextDecoder().decode(result.stdout).includes('Thursday'), 'real gstack context loader receives cloud memory via GBrain CLI: ' + new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr));
    checks.push('gstack context loader via CLI');
  }
  await write('notes/deployment', sentence.replace('Thursday', 'Friday'));
  await drainAllBackgroundWorkForCliExit();
  await a.executeRaw("UPDATE pages SET updated_at = now() - interval '1 minute'");
  await mirrorBrain(a, conn, { full: true });
  const updated = await handleToolCall(b, 'recall', { query: 'cobalt widget deployment schedule', source_id: source });
  assert.ok(JSON.stringify(updated).includes('Friday'), 'edited memory becomes searchable');
  checks.push('write-through update');
  await runCloud(a, ['primary', 'off']);
  const local = await handleToolCall(a, 'query', { query: 'cobalt widget deployment', source_id: source, expand: false });
  assert.ok(JSON.stringify(local).includes('Friday'), 'local fallback retains memory');
  checks.push('local off switch');
  await a.softDeletePage('notes/deployment', { sourceId: source });
  await a.executeRaw("UPDATE pages SET deleted_at = now() - interval '1 minute' WHERE slug = 'notes/deployment'");
  await a.setConfig(HYDRADB_CONFIG.deletedSince, '2000-01-01T00:00:00Z');
  await mirrorBrain(a, conn);
  const removed = await handleToolCall(b, 'query', { query: 'cobalt widget deployment', source_id: source, expand: false });
  assert.ok(!JSON.stringify(removed).includes('Friday'), 'deleted memory is removed from HydraDB');
  checks.push('cloud deletion');
  console.log(JSON.stringify({ database, api_url: conn.baseUrl, checks }, null, 2));
} finally {
  await drainAllBackgroundWorkForCliExit();
  if (connected) {
    // Only this script's unique test database is eligible for cleanup.
    await hydraRequest({ apiKey: process.env.HYDRA_DB_API_KEY!, baseUrl: process.env.HYDRA_DB_BASE_URL }, 'DELETE', '/databases', { query: { database } });
    console.log(`Removed synthetic database ${database}.`);
  }
  await a.disconnect(); await b.disconnect(); rmSync(scratch, { recursive: true, force: true });
}
