/**
 * An ordinary supersession ("works at acme-example" → "left acme-example")
 * is an update, not a withdrawal. On the fence path it used to route through
 * forget: a durable withdrawal that blocked the old claim forever and, as a
 * side effect, invalidated every page in the source. Gmail commitment
 * extraction hits this path on every changed due date.
 *
 * Real PGLite; the embedding transport is a deterministic in-process stub.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let brainDir: string;
const SLUG = 'people/alice-example';
const DIM = 1536;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  brainDir = mkdtempSync(join(tmpdir(), 'supersede-'));
  await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [brainDir]);
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIM, env: { OPENAI_API_KEY: 'sk-test-deterministic' } });
  __setEmbedTransportForTests((async (opts: { values: string[] }) => ({
    embeddings: opts.values.map(t => {
      const v = new Array(DIM).fill(0);
      if (t.includes('SUPERSEDE-PAIR')) v[0] = 1;
      else for (let i = 0; i < 16; i++) v[i] = ((t.charCodeAt(i % t.length) % 13) + 1) / 13;
      return v;
    }),
  })) as never);
  for (const [slug, title] of [[SLUG, 'Alice Example'], ['companies/acme-example', 'Acme Example']]) {
    const content = `---\ntitle: ${title}\ntype: ${slug.startsWith('people') ? 'person' : 'company'}\n---\n# ${title}\n\nSearchable body about ${title}.\n`;
    mkdirSync(join(brainDir, slug.split('/')[0]), { recursive: true });
    writeFileSync(join(brainDir, `${slug}.md`), content);
    await importFromContent(engine, slug, content, { noEmbed: true, sourceId: 'default' });
  }
});

afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
  rmSync(brainDir, { recursive: true, force: true });
});

async function chunkCount(slug: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT count(c.id)::int AS n FROM pages p LEFT JOIN content_chunks c ON c.page_id=p.id WHERE p.slug=$1`, [slug]);
  return rows[0].n;
}

describe('fence-path supersession', () => {
  test('supersedes without recording a withdrawal or touching unrelated pages', async () => {
    const first = await writeSingleFact(engine, 'default', { fact: 'SUPERSEDE-PAIR works at acme-example', provenance: 'test', entity: SLUG, kind: 'fact', visibility: 'world' });
    expect(first.status).toBe('inserted');
    const unrelatedChunks = await chunkCount('companies/acme-example');
    expect(unrelatedChunks).toBeGreaterThan(0);

    const second = await writeSingleFact(engine, 'default', { fact: 'SUPERSEDE-PAIR left acme-example', provenance: 'test', entity: SLUG, kind: 'fact', visibility: 'world' });

    expect(second.status).toBe('superseded');
    expect(await engine.executeRaw('SELECT * FROM fact_withdrawals')).toEqual([]);
    const [old] = await engine.executeRaw<{ expired: boolean; superseded_by: number | null }>(
      `SELECT expired_at IS NOT NULL AS expired, superseded_by FROM facts WHERE id=$1`, [first.id]);
    expect(old).toEqual({ expired: true, superseded_by: second.id });
    const file = readFileSync(join(brainDir, `${SLUG}.md`), 'utf-8');
    expect(file).toMatch(/~~SUPERSEDE-PAIR works at acme-example~~[^\n]*superseded by #2/);
    expect(file).not.toContain('forgotten:');
    expect(await chunkCount('companies/acme-example')).toBe(unrelatedChunks);
  });

  test('the superseded claim can be remembered again later', async () => {
    await writeSingleFact(engine, 'default', { fact: 'SUPERSEDE-PAIR works at acme-example', provenance: 'test', entity: SLUG, kind: 'fact', visibility: 'world' });
    await writeSingleFact(engine, 'default', { fact: 'SUPERSEDE-PAIR left acme-example', provenance: 'test', entity: SLUG, kind: 'fact', visibility: 'world' });
    const back = await writeSingleFact(engine, 'default', { fact: 'SUPERSEDE-PAIR works at acme-example', provenance: 'test', entity: SLUG, kind: 'fact', visibility: 'world' });
    expect(['inserted', 'superseded']).toContain(back.status);
  });
});
