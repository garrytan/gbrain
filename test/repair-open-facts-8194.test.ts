/**
 * Discussion #8194 (GBRA-575): `gbrain repair open-facts`, the operator-only repair that opens facts stamped private
 * before `facts.default_visibility world`.
 *
 * 1. Protects: an operator on the brain host can open legacy private facts in one named source, preview first, then
 *    `--apply --expect <hash>`, keeping each fact's id, provenance and creation time; a remote source-granted caller
 *    recalls them afterwards and not before; facts on private, reader-restricted or member pages, and expired facts,
 *    stay private; the tighten repair plans nothing for what was opened. Managed and unmanaged, repo-less.
 * 2. Fails when: the preview writes anything, the apply opens a fact outside the previewed set, a fact changes id, an
 *    excluded fact opens, `gbrain repair visibility` would close an opened fact, or the kind runs from `--all`.
 * 3. Real seams: the gbrain repair CLI module (parse and dispatch), MCP operation handlers with remote=true and a
 *    source-granted token, PGLite (Postgres too when DATABASE_URL is set).
 * Red before the build: the kind does not exist yet. The last describe is a pin that is green today.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { Principal } from '../src/core/persistence/model.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { registerLocalWriter, readLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { REPAIR_KINDS } from '../src/core/repair/core.ts';
import { AUTO_REPAIR_REGISTRY, EXPLICIT_REPAIR_REGISTRY } from '../src/core/repair/registry.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';
import { withEnv } from './helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const engines: BrainEngine[] = [];
const home = mkdtempSync(join(tmpdir(), 'gbrain-open-facts-'));
let closePostgres: (() => Promise<void>) | undefined;
const quiet = { info() {}, warn() {}, error() {} };

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}), 120_000);
afterAll(async () => {
  resetGateway();
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

interface Brain { engine: BrainEngine; sourceId: string; remote: OperationContext; local: OperationContext }
/** A source on a shared-shaped brain (no owner, no members) with a token granted only that source. */
async function brain(engine: BrainEngine, managed: boolean): Promise<Brain> {
  const sourceId = `open-${randomUUID().slice(0, 8)}`;
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await engine.setConfig('brain.audience', 'shared');
  await registerLocalWriter(engine, 'cli');
  const minted = await mintLegacyToken(engine, { name: `token-${sourceId}`, scopes: ['read', 'write'], sourceGrant: [sourceId], takesHolders: ['world'] });
  await readsUnscopedOnPurpose(engine, minted.id);
  if (managed) await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const base = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId, dryRun: false, logger: quiet };
  await readLocalWriter(engine, 'cli');
  return {
    engine, sourceId,
    remote: { ...base, remote: true, transport: 'http', takesHoldersAllowList: ['world'],
      auth: { token: '', clientId: minted.id, principal: { kind: 'legacy_token', id: minted.id } as Principal, sourceId, allowedSources: [sourceId], scopes: ['read', 'write'] } },
    local: { ...base, remote: false },
  } as Brain;
}
const run = (ctx: OperationContext, op: string, params: Record<string, unknown>) =>
  operationsByName[op].handler(ctx, { request_id: randomUUID(), ...params }) as Promise<Record<string, any>>;

const fence = (rows: Array<[number, string, 'private' | 'world']>) => ['## Facts', '', '<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
  ...rows.map(([n, claim, vis]) => `| ${n} | ${claim} | fact | 1.0 | ${vis} | medium | 2026-09-01 |  | fixture |  |`),
  '<!--- gbrain:facts:end -->'].join('\n');
const pageText = (slug: string, front: string, rows: Array<[number, string, 'private' | 'world']>) =>
  `---\ntype: company\ntitle: ${slug}\n${front}---\n\n# ${slug}\n\nOrchardline body.\n\n${fence(rows)}\n`;
const page = (b: Brain, slug: string, front: string, rows: Array<[number, string, 'private' | 'world']>) =>
  run(b.local, 'put_page', { slug, content: pageText(slug, front, rows) });

/** A database-only private fact (no fence row), as older extraction lanes stored them. */
async function dbOnly(b: Brain, fact: string, holder: string, expired = false): Promise<number> {
  const rows = await b.engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId], () => tx.executeRaw<{ id: number }>(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_markdown_slug, expired_at)
     VALUES ($1, $2, $3, 'fact', 'private', 'mcp:extract_facts', $2, ${expired ? 'now()' : 'NULL'}) RETURNING id`, // gbrain-allow-direct-insert: legacy database-only fact fixture
    [b.sourceId, holder, fact]), TEST_WRITE_ATTRIBUTION));
  return Number(rows[0].id);
}
const facts = async (b: Brain, claim: string) => b.engine.executeRaw<{ id: number; visibility: string; row_num: number | null; created_at: string; source: string }>(
  'SELECT id::int AS id, visibility, row_num, created_at::text AS created_at, source FROM facts WHERE source_id=$1 AND fact=$2 AND expired_at IS NULL ORDER BY id', [b.sourceId, claim]);
async function remoteRecall(b: Brain, entity: string): Promise<string> {
  __resetPrivateVisibilityCacheForTests();
  return JSON.stringify(await run(b.remote, 'recall', { entity }));
}
async function cli(engine: BrainEngine, args: string[]): Promise<string> {
  const lines: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  try { await runRepairCommand(engine, args); } finally { log.mockRestore(); }
  return lines.join('\n');
}
const expectHash = (out: string) => out.match(/--expect ([0-9a-f]{16,})/)?.[1];

describe('repair open-facts: registration', () => {
  test('the kind exists, runs only when named and never from --all or the remediation plan', () => {
    expect(REPAIR_KINDS as readonly string[]).toContain('open-facts');
    expect(EXPLICIT_REPAIR_REGISTRY.map(s => s.kind)).toContain('open-facts');
    expect(AUTO_REPAIR_REGISTRY.map(s => s.kind)).not.toContain('open-facts');
  });
});

for (const managed of [false, true]) {
  describe(`repair open-facts on a shared brain with no owner (${managed ? 'managed' : 'unmanaged'}, repo-less)`, () => {
    test('opens exactly the previewed legacy private facts, keeps ids, and leaves every excluded fact private', async () => withEnv({ GBRAIN_HOME: home }, async () => {
      for (const engine of engines) {
        const b = await brain(engine, managed);
        await page(b, 'companies/acme-example', '', [[1, 'Acme Example orchardline revenue grew', 'private'], [2, 'Acme Example is in Springfield', 'world']]);
        await page(b, 'secret/plan-example', 'visibility: private\n', [[1, 'Orchardline merger plan', 'private']]);
        await page(b, 'people/alice-example', 'readable_by: [alice-example]\n', [[1, 'Alice Example orchardline salary', 'private']]);
        const loose = await dbOnly(b, 'Acme Example orchardline database-only legacy fact', 'companies/acme-example');
        await dbOnly(b, 'Orchardline fact held on a private page', 'secret/plan-example');
        const expired = await dbOnly(b, 'Orchardline expired fact', 'companies/acme-example', true);

        const [fencedBefore] = await facts(b, 'Acme Example orchardline revenue grew');
        const [looseBefore] = await facts(b, 'Acme Example orchardline database-only legacy fact');
        expect(fencedBefore.visibility).toBe('private');
        expect(looseBefore.visibility).toBe('private');
        expect(await remoteRecall(b, 'companies/acme-example')).not.toContain('orchardline revenue grew');

        const preview = await cli(engine, ['open-facts', '--source', b.sourceId]);
        const hash = expectHash(preview);
        expect(hash).toBeTruthy();
        expect((await facts(b, 'Acme Example orchardline revenue grew'))[0].visibility).toBe('private');

        await cli(engine, ['open-facts', '--source', b.sourceId, '--apply', '--expect', hash!]);

        expect((await facts(b, 'Acme Example orchardline revenue grew')).map(f => [f.id, f.visibility, f.row_num])).toEqual([[fencedBefore.id, 'world', 1]]);
        expect((await facts(b, 'Acme Example orchardline database-only legacy fact')).map(f => [f.id, f.visibility, f.created_at, f.source]))
          .toEqual([[loose, 'world', looseBefore.created_at, looseBefore.source]]);
        for (const claim of ['Orchardline merger plan', 'Alice Example orchardline salary', 'Orchardline fact held on a private page']) {
          expect((await facts(b, claim)).map(f => f.visibility)).toEqual(['private']);
        }
        const [exp] = await engine.executeRaw<{ visibility: string }>('SELECT visibility FROM facts WHERE id=$1', [expired]);
        expect(exp.visibility).toBe('private');
        expect((await engine.executeRaw('SELECT 1 FROM trust_proposals WHERE related_id = ANY($1::bigint[])', [[fencedBefore.id, loose]])).length).toBe(0);

        const recalled = await remoteRecall(b, 'companies/acme-example');
        expect(recalled).toContain('orchardline revenue grew');
        expect(recalled).toContain('orchardline database-only legacy fact');

        const tighten = await cli(engine, ['visibility', '--source', b.sourceId, '--json']);
        expect(tighten).not.toContain(`fact ${fencedBefore.id} `);
        expect(tighten).not.toContain(`fact ${loose} `);
      }
    }), 240_000);

    test('a changed set refuses the stale hash and opens nothing', async () => withEnv({ GBRAIN_HOME: home }, async () => {
      for (const engine of engines) {
        const b = await brain(engine, managed);
        await page(b, 'companies/acme-example', '', [[1, 'Acme Example is in Springfield', 'world']]);
        await dbOnly(b, 'Orchardline stale-hash fact one', 'companies/acme-example');
        const hash = expectHash(await cli(engine, ['open-facts', '--source', b.sourceId]));
        await dbOnly(b, 'Orchardline stale-hash fact two', 'companies/acme-example');
        await expect(cli(engine, ['open-facts', '--source', b.sourceId, '--apply', '--expect', hash!])).rejects.toMatchObject({ code: 'preview_changed' });
        expect((await facts(b, 'Orchardline stale-hash fact one')).map(f => f.visibility)).toEqual(['private']);
      }
    }), 120_000);
  });
}

describe('remote page rewrite keeps hidden private fence rows (Discussion #8194, second half; a pin, green today)', () => {
  test('a remote put_page that rewrites only the body keeps the private row in the page and the database with the same id', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      for (const managed of [false, true]) {
        const b = await brain(engine, managed);
        await page(b, 'companies/beta-example', '', [[1, 'Beta Example orchardline private row', 'private'], [2, 'Beta Example world row', 'world']]);
        const [before] = await facts(b, 'Beta Example orchardline private row');
        expect(before.visibility).toBe('private');
        const read = await run(b.remote, 'get_page', { slug: 'companies/beta-example', include_content: true });
        expect(String(read.content)).not.toContain('orchardline private row');
        await run(b.remote, 'put_page', { slug: 'companies/beta-example', expected_revision: read.revision, content_origin: 'user_said',
          content: String(read.content).replace('Orchardline body.', 'Orchardline body, rewritten.') });
        expect((await facts(b, 'Beta Example orchardline private row')).map(f => [f.id, f.visibility, f.row_num])).toEqual([[before.id, 'private', 1]]);
        const [stored] = await engine.executeRaw<{ body: string }>('SELECT compiled_truth AS body FROM pages WHERE source_id=$1 AND slug=$2', [b.sourceId, 'companies/beta-example']);
        expect(stored.body).toContain('Beta Example orchardline private row');
        expect(stored.body).toContain('Orchardline body, rewritten.');
      }
    }
  }), 180_000);
});
