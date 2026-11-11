/**
 * A fact purge deletes the chunks of every page its plan names, including a
 * page whose body did not hold the purged row and so was not rewritten. Such
 * a page loses its chunks, so its text projection seal must go with them, or
 * the embedding state reads it as sealed-empty and nothing ever re-chunks it
 * (R51 review of the doctor/dream/enrich train, #8502). Real PGLite.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { operations } from '../src/core/operations.ts';
import { withEnv } from './helpers/with-env.ts';

const CLAIM = 'Gate code is 7731';
const home = mkdtempSync(join(tmpdir(), 'gbrain-purge-seal-'));
let engine: PGLiteEngine;

const fence = (rows: string[]) => `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows.join('\n')}
<!--- gbrain:facts:end -->`;
const ROW_TEA = '| 1 | Likes green tea | preference | 1.0 | world | medium | 2026-01-01 |  | chat |  |';
const ROW_CLAIM = `| 2 | ${CLAIM} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |`;
const body = (rows: string[]) => `---\ntitle: Bob\ntype: person\n---\n# Bob\n\nProse about bob-example and the garden.\n\n## Facts\n\n${fence(rows)}\n`;

let ctx: OperationContext;
const purge = operations.find(o => o.name === 'purge_fact')!;

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await registerLocalWriter(engine, 'cli');
  ctx = { engine, sourceId: 'default', remote: false, dryRun: false,
    config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
}), 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

test('an unrewritten page whose chunks a purge deletes stays healable', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const slug = 'people/bob-example';
  await importFromContent(engine, slug, body([ROW_TEA, ROW_CLAIM]), { noEmbed: true, sourceId: 'default' });
  await runExtractFacts(engine, { slugs: [slug] });
  const [fact] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE fact=$1 AND entity_slug=$2', [CLAIM, slug]);
  expect(fact).toBeDefined();
  await importFromContent(engine, slug, body([ROW_TEA]), { noEmbed: true, sourceId: 'default' });
  const [before] = await engine.executeRaw<{ sealed: boolean; chunks: number }>(
    `SELECT p.text_projection_revision IS NOT DISTINCT FROM p.knowledge_revision AS sealed,
       (SELECT count(*)::int FROM content_chunks c WHERE c.page_id = p.id) AS chunks FROM pages p WHERE p.slug = $1`, [slug]);
  expect(before).toEqual({ sealed: true, chunks: expect.any(Number) });
  expect(before!.chunks).toBeGreaterThan(0);
  const healableBefore = await engine.countChunklessPagesWithContent();
  const id = Number(fact!.id);
  const dry = await purge.handler(ctx, { id, dry_run: true }) as Record<string, unknown>;
  await purge.handler(ctx, { id, confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() });
  const [after] = await engine.executeRaw<{ sealed: boolean; chunks: number }>(
    `SELECT p.text_projection_revision IS NOT DISTINCT FROM p.knowledge_revision AS sealed,
       (SELECT count(*)::int FROM content_chunks c WHERE c.page_id = p.id) AS chunks FROM pages p WHERE p.slug = $1`, [slug]);
  expect(after).toEqual({ sealed: false, chunks: 0 });
  expect(await engine.countChunklessPagesWithContent()).toBe(healableBefore + 1);
}), 60_000);
