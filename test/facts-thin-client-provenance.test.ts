/**
 * #4819 — page provenance for facts on a thin-client install.
 *
 * With no `sources.local_path` there is no fence lane: every fact the page
 * backstop extracts goes through the legacy single-row engine.insertFact.
 * Those rows must keep `source_markdown_slug` NULL — it is the
 * fence-ownership key `extract_facts` hard-deletes by (deleteFactsForPage),
 * so populating it gets the row wiped on the next reconcile of a fence-less
 * page. The page the claim came from therefore rides `facts.context`, the
 * #4206 provenance carrier. Before the fix the page path never set it, so a
 * thin-client row had no provenance in either column.
 *
 * Real PGLite + the chat-transport stub; no API keys, no network.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runFactsBackstop, type FactsBackstopCtx } from '../src/core/facts/backstop.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import {
  __setChatTransportForTests,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { __resetFactsQueueForTests } from '../src/core/facts/queue.ts';

let engine: PGLiteEngine;
let pageLockRoot: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  pageLockRoot = mkdtempSync(join(tmpdir(), 'facts-thin-client-provenance-'));
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(pageLockRoot, { recursive: true, force: true });
});

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
  __resetFactsQueueForTests();
});

// Clears eligibility's MIN_BODY_CHARS (80) for type 'meeting'.
const LONG_BODY = 'thin-client provenance meeting note about acme-example '.repeat(4);

function chatStub(fact: string) {
  __setChatTransportForTests(async (): Promise<ChatResult> => ({
    text: JSON.stringify({
      facts: [{ fact, kind: 'fact', entity: null, confidence: 1.0, notability: 'medium' }],
    }),
    blocks: [],
    stopReason: 'end',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'test:stub',
    providerId: 'test',
  }));
}

async function backstopPage(slug: string, extra: Partial<FactsBackstopCtx> = {}): Promise<number> {
  const r = await runFactsBackstop(
    { slug, type: 'meeting', compiled_truth: LONG_BODY, frontmatter: {} },
    { engine, sourceId: 'default', sessionId: null, source: 'mcp:put_page', mode: 'inline', ...extra },
  );
  expect(r.mode).toBe('inline');
  if (r.mode !== 'inline') throw new Error('unreachable');
  expect(r.skipped).toBeUndefined();
  expect(r.fact_ids).toHaveLength(1);
  return r.fact_ids[0];
}

type FactRow = { context: string | null; row_num: number | null; source_markdown_slug: string | null };

async function factRow(id: number): Promise<FactRow> {
  const rows = await engine.executeRaw<FactRow>(
    `SELECT context, row_num, source_markdown_slug FROM facts WHERE id = $1`,
    [id],
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe('thin-client facts carry page provenance in facts.context (#4819)', () => {
  test('precondition: a fresh seed leaves sources.local_path NULL for default', async () => {
    const rows = await engine.executeRaw<{ local_path: string | null }>(
      `SELECT local_path FROM sources WHERE id = 'default'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].local_path).toBeNull();
  });

  test('legacy DB-only insert: context = page slug, source_markdown_slug stays NULL', async () => {
    chatStub('thin-client provenance fact one');
    const slug = 'meetings/provenance-alice-example';
    const row = await factRow(await backstopPage(slug));
    // Legacy-path preconditions: no fence row number, and the fence-ownership
    // key stays NULL (guards against the "fill the INSERT column" anti-fix
    // that makes extract_facts hard-delete the row).
    expect(row.row_num).toBeNull();
    expect(row.source_markdown_slug).toBeNull();
    // The defect: no page provenance anywhere. Fixed = the page slug in context.
    expect(row.context).toBe(slug);
  });

  test('a caller-supplied sourceSlug still wins over the page slug', async () => {
    chatStub('thin-client provenance fact two');
    const row = await factRow(
      await backstopPage('meetings/provenance-bob-example', { sourceSlug: 'transcripts/session-1' }),
    );
    expect(row.context).toBe('transcripts/session-1');
  });

  test('the row survives an extract_facts reconcile of its fence-less page', async () => {
    chatStub('thin-client provenance fact three');
    const slug = 'meetings/provenance-reconcile-acme-example';
    await engine.putPage(slug, {
      title: slug,
      type: 'meeting',
      compiled_truth: LONG_BODY,
      frontmatter: {},
      timeline: '',
    });
    const id = await backstopPage(slug);
    await runExtractFacts(engine, { slugs: [slug], sourceId: 'default', pageLockRoot });
    const rows = await engine.executeRaw<{ n: string | number }>(
      `SELECT COUNT(*)::text AS n FROM facts WHERE id = $1`,
      [id],
    );
    expect(Number(rows[0].n)).toBe(1);
  });
});
