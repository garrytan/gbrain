/**
 * `gbrain pages unsearchable` (#6696 B3): the read-only listing of embedding
 * state rows for one source. JSON shape (rows with slug/state/reason/chunks/
 * bytes and a rendered protocol fix, completeness flag, per-source counts),
 * `--state` filtering, bounded `--limit`, and `--state` validation
 * (`invalid_params` naming every valid state, exit 2 with one JSON envelope).
 *
 * Protects: the operator/agent listing the doctor and troubleshooting guide
 * point at. Regression: an unvalidated state silently listing nothing, a row
 * without its exit, or a listing that ignores its source scope. In-process on
 * PGLite, plus one CLI subprocess for the refusal's exit code and envelope.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runPages } from '../src/commands/pages.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { EMBEDDING_STATES } from '../src/core/embedding-state.ts';
import { makeDoctorHome, runGbrain } from './helpers/doctor-json-golden.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.unsetConfig('embedding_disabled');
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('src-b','src-b') ON CONFLICT DO NOTHING");
  await seed();
});

async function page(slug: string, opts: { source?: string; body?: string; frontmatter?: Record<string, unknown>; chunks?: number; vector?: boolean } = {}): Promise<void> {
  const source = opts.source ?? 'default';
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: opts.body ?? `${slug} body` }, { sourceId: source });
  const [row] = await engine.executeRaw<{ id: number }>('UPDATE pages SET frontmatter = $3::jsonb WHERE slug = $1 AND source_id = $2 RETURNING id',
    [slug, source, JSON.stringify(opts.frontmatter ?? {})]);
  await engine.executeRaw('DELETE FROM content_chunks WHERE page_id = $1', [row!.id]);
  for (let i = 0; i < (opts.chunks ?? 0); i++) {
    await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, embedding)
      VALUES ($1, $2, 'abcd', ${opts.vector ? 'array_fill(0.1::real, ARRAY[1536])::vector' : 'NULL'})`, [row!.id, i]);
  }
}

async function seed(): Promise<void> {
  await page('notes/alice-example', { chunks: 2, vector: true });
  await page('notes/acme-example', { chunks: 3 });
  await page('notes/fund-a-oversized', { chunks: 1, frontmatter: { embed_skip: { reason: 'oversized', bytes: 600_000, assessed_at: '2026-01-01T00:00:00Z' } } });
  await page('notes/stub-with-body');
  await page('notes/other-source', { source: 'src-b', chunks: 4 });
}

async function run(args: string[]): Promise<string> {
  const lines: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  try {
    await runPages(engine as never, ['unsearchable', ...args]);
  } finally {
    log.mockRestore();
  }
  return lines.join('\n');
}

interface Listing {
  source_id: string; state: string | null; limit: number; complete: boolean; active_column: string; unsearchable: number;
  counts: Record<string, number>;
  rows: Array<{ slug: string; source_id: string; state: string; reason: string; chunks: number; bytes: number; marker_bytes?: number;
    fix: { next: string; command?: string; argv?: string[]; consent: string[]; actor: string; why: string; requires_exclusive: boolean; docs?: string; verify?: { argv?: string[] } } | null }>;
}

describe('gbrain pages unsearchable', () => {
  test('--json lists every non-embedded state in the source with reason, bytes and a protocol fix', async () => {
    const out = JSON.parse(await run(['--source', 'default', '--json'])) as Listing;
    expect(out).toMatchObject({ source_id: 'default', state: null, limit: 50, complete: true, active_column: 'embedding', unsearchable: 3 + 1 });
    expect(out.counts).toMatchObject({ embedded: 2, pending: 3, keyword_only: 1, chunkless_healable: 1 });
    expect(out.rows.map(r => [r.state, r.slug, r.reason, r.chunks])).toEqual([
      ['chunkless_healable', 'notes/stub-with-body', 'no_chunk_rows', 0],
      ['keyword_only', 'notes/fund-a-oversized', 'oversized', 1],
      ['pending', 'notes/acme-example', 'no_vector', 3],
    ]);
    expect(out.rows.find(r => r.state === 'pending')!.bytes).toBe(12);
    expect(out.rows.find(r => r.state === 'keyword_only')!.marker_bytes).toBe(600_000);
    for (const row of out.rows) {
      expect(row.source_id).toBe('default');
      expect(row.fix).toMatchObject({ actor: expect.any(String), consent: expect.any(Array), why: expect.any(String), requires_exclusive: false });
      expect(row.fix!.docs).toContain('troubleshooting.md#embedding-state');
      expect(row.fix!.verify?.argv).toEqual(['gbrain', 'pages', 'unsearchable', '--source', 'default', '--state', row.state, '--json']);
    }
    expect(out.rows.find(r => r.state === 'pending')!.fix).toMatchObject({ argv: ['gbrain', 'embed', '--stale', '--catch-up', '--source', 'default', '--yes'], consent: ['paid'] });
    // A marker under the current bytes_block (the 24 MiB default) predates it: the free backfill clears it, never a lowered limit.
    expect(out.rows.find(r => r.state === 'keyword_only')!.fix).toMatchObject({ next: 'run', argv: ['gbrain', 'reindex', '--oversized', '--source', 'default'], consent: [] });
  });

  test('a page over the operator\'s bytes_block is asked about raising the limit to just above its marker', async () => {
    await engine.setConfig('content_sanity.bytes_block', '500000');
    try {
      const out = JSON.parse(await run(['--source', 'default', '--state', 'keyword_only', '--json'])) as Listing;
      expect(out.rows[0]!.fix).toMatchObject({ next: 'ask_user', argv: ['gbrain', 'config', 'set', 'content_sanity.bytes_block', '600001'] });
    } finally {
      await engine.unsetConfig('content_sanity.bytes_block');
    }
  });

  test('--state filters, embedded is reachable only through --state, and the source scope holds', async () => {
    const pending = JSON.parse(await run(['--source', 'default', '--state', 'pending', '--json'])) as Listing;
    expect(pending.rows.map(r => r.slug)).toEqual(['notes/acme-example']);
    const embedded = JSON.parse(await run(['--source', 'default', '--state', 'embedded', '--json'])) as Listing;
    expect(embedded.rows.map(r => [r.slug, r.fix])).toEqual([['notes/alice-example', null]]);
    const other = JSON.parse(await run(['--source', 'src-b', '--json'])) as Listing;
    expect(other.rows.map(r => [r.state, r.slug, r.chunks])).toEqual([['pending', 'notes/other-source', 4]]);
  });

  test('--limit bounds the rows and reports complete:false', async () => {
    const out = JSON.parse(await run(['--source', 'default', '--limit', '2', '--json'])) as Listing;
    expect(out.rows).toHaveLength(2);
    expect(out.complete).toBe(false);
  });

  test('an unknown --state or a bad --limit is invalid_params naming the valid values', async () => {
    let caught: unknown;
    try { await run(['--source', 'default', '--state', 'stale']); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(OperationError);
    expect((caught as OperationError).code).toBe('invalid_params');
    for (const state of EMBEDDING_STATES) expect((caught as OperationError).message).toContain(state);
    await expect(run(['--limit', '0'])).rejects.toMatchObject({ code: 'invalid_params' });
  });

  test('human output names each row and its fix', async () => {
    const out = await run(['--source', 'default']);
    expect(out).toContain('pending');
    expect(out).toContain('notes/acme-example');
    expect(out).toContain('fix (ask user): gbrain embed --stale --catch-up --source default --yes');
  });
});

describe('gbrain pages unsearchable (CLI)', () => {
  test('an unknown --state exits 2 with one invalid_params envelope', async () => {
    const h = makeDoctorHome('pages-unsearchable');
    try {
      const init = await runGbrain(h, ['init', '--pglite', '--no-embedding']);
      expect(init.exitCode).toBe(0);
      const run = await runGbrain(h, ['pages', 'unsearchable', '--state', 'stale', '--json']);
      expect(run.exitCode).toBe(2);
      expect(run.json).toMatchObject({ code: 'invalid_params' });
      expect(String((run.json as { message: string }).message)).toContain('chunkless_healable');
      const ok = await runGbrain(h, ['pages', 'unsearchable', '--json']);
      expect(ok.exitCode).toBe(0);
      expect(ok.json).toMatchObject({ source_id: 'default', complete: true, rows: [] });
    } finally {
      h.cleanup();
    }
  }, 120_000);
});
