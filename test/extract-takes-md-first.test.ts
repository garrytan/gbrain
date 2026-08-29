/**
 * #4473 — takes bootstrap is md-FIRST.
 *
 * extractTakesFromPages used to call engine.addTakesBatch directly, minting
 * DB-only takes rows. Takes are markdown-canonical (takes-write.ts contract):
 * the md→DB reconcile upserts from the fence and the extract rebuild lane
 * deletes+reinserts from md, so DB-only rows were silently clobbered by the
 * next sync/extract. Pins:
 *
 *   1. a bootstrapped claim lands in the page's ## Takes fence on disk AND
 *      mirrors to the takes table (same rows);
 *   2. a page with no locatable .md file is SKIPPED (reason
 *      mirror_unavailable) — no DB-only row is minted, and the skip happens
 *      BEFORE the LLM call (no classifier budget burned);
 *   3. dry-run counts claims without touching disk or DB;
 *   4. row numbers derive from the fence (existing fence rows are extended,
 *      not collided with at row_num=1).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
} from '../src/core/ai/gateway.ts';
import { extractTakesFromPages } from '../src/core/extract-takes-from-pages.ts';
import { parseTakesFence } from '../src/core/takes-fence.ts';

let engine: PGLiteEngine;
let repo: string;
let chatCalls: string[] = [];

const BODY = 'An opinion-bearing body long enough to clear the 200-char eligibility floor. '.repeat(5);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  repo = mkdtempSync(join(tmpdir(), 'gb-takes-md-first-'));
  mkdirSync(join(repo, 'concepts'), { recursive: true });
  await engine.setConfig('sync.repo_path', repo);

  configureGateway({
    chat_model: 'anthropic:claude-haiku-4-5-20251001',
    env: { ANTHROPIC_API_KEY: 'sk-ant-test-md-first' },
  });
  __setChatTransportForTests(async (opts) => {
    // Record which page was classified (the <page slug="..."> wrapper).
    const user = opts.messages?.find((m: { role: string }) => m.role === 'user');
    const text = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content ?? '');
    const m = text.match(/<page slug="([^"]+)"/);
    chatCalls.push(m?.[1] ?? '(unknown)');
    return {
      text: '[{"claim":"a bootstrapped claim","kind":"take","weight":0.7}]',
      blocks: [{ type: 'text' as const, text: '[{"claim":"a bootstrapped claim","kind":"take","weight":0.7}]' }],
      stopReason: 'end' as const,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-haiku-4-5-20251001',
      providerId: 'anthropic',
    };
  });
});

afterAll(async () => {
  __setChatTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  rmSync(repo, { recursive: true, force: true });
});

describe('extractTakesFromPages — md-first (#4473)', () => {
  test('bootstrapped claim lands in the fence on disk AND mirrors to the DB', async () => {
    const slug = 'concepts/md-first-covered';
    await engine.putPage(slug, { type: 'concept', title: 'Covered', compiled_truth: BODY, frontmatter: {} });
    writeFileSync(join(repo, `${slug}.md`), `# Covered\n\n${BODY}\n`, 'utf-8');

    const r = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 50, holder: 'system' });
    expect(r.claims_extracted).toBe(1);
    expect(r.pages_skipped).toBe(0);

    // Markdown is canonical: the fence exists on disk with the claim.
    const fence = parseTakesFence(readFileSync(join(repo, `${slug}.md`), 'utf-8'));
    expect(fence.takes.length).toBe(1);
    expect(fence.takes[0].claim).toBe('a bootstrapped claim');
    expect(fence.takes[0].holder).toBe('system');

    // DB mirror carries the same row (keyed on the fence row number).
    const rows = await engine.executeRaw<{ claim: string; row_num: number }>(
      `SELECT t.claim, t.row_num FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.slug = $1`,
      [slug],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].claim).toBe('a bootstrapped claim');
    expect(rows[0].row_num).toBe(fence.takes[0].rowNum);
  });

  test('page with no locatable .md file: skipped BEFORE the LLM call, no DB-only row', async () => {
    const slug = 'concepts/md-first-db-born';
    await engine.putPage(slug, { type: 'concept', title: 'DB-born', compiled_truth: BODY, frontmatter: {} });
    // No .md file written — a DB-born page.

    chatCalls = [];
    const r = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 50 });
    expect(r.pages_skipped).toBe(1);
    expect(r.skipped).toEqual([{ slug, reason: 'mirror_unavailable' }]);
    expect(r.claims_extracted).toBe(0);
    // The classifier never ran for the unwritable page (budget honesty).
    expect(chatCalls).not.toContain(slug);

    // No DB-only row was minted (the pre-fix failure mode).
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.slug = $1`,
      [slug],
    );
    expect(rows[0].n).toBe(0);
    // And no twin .md file was created.
    expect(existsSync(join(repo, `${slug}.md`))).toBe(false);
  });

  test('dry-run counts claims without touching disk or DB', async () => {
    const slug = 'concepts/md-first-dry';
    await engine.putPage(slug, { type: 'concept', title: 'Dry', compiled_truth: BODY, frontmatter: {} });
    writeFileSync(join(repo, `${slug}.md`), `# Dry\n\n${BODY}\n`, 'utf-8');

    const r = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 50, dryRun: true });
    // Dry-run rescans BOTH uncovered pages (db-born included — no file gate on dry-run).
    expect(r.claims_extracted).toBeGreaterThanOrEqual(1);
    const md = readFileSync(join(repo, `${slug}.md`), 'utf-8');
    expect(md).not.toContain('gbrain:takes');
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.slug = $1`,
      [slug],
    );
    expect(rows[0].n).toBe(0);
  });

  test('existing fence rows are extended, not collided with at row_num=1', async () => {
    const slug = 'concepts/md-first-extend';
    await engine.putPage(slug, { type: 'concept', title: 'Extend', compiled_truth: BODY, frontmatter: {} });
    // Pre-existing fence with one hand-written row.
    writeFileSync(
      join(repo, `${slug}.md`),
      `# Extend\n\n${BODY}\n\n## Takes\n\n<!--- gbrain:takes:begin -->\n` +
      `| # | claim | kind | who | weight | since | source |\n` +
      `|---|-------|------|-----|--------|-------|--------|\n` +
      `| 1 | Hand-written claim | take | world | 0.5 |  |  |\n` +
      `<!--- gbrain:takes:end -->\n`,
      'utf-8',
    );

    const r = await extractTakesFromPages(engine, {
      bootstrapEnabled: true, maxPages: 50, includeCovered: true, sourceIdFilter: 'default',
    });
    expect(r.claims_extracted).toBeGreaterThanOrEqual(1);

    const fence = parseTakesFence(readFileSync(join(repo, `${slug}.md`), 'utf-8'));
    const claims = fence.takes.map((t) => t.claim);
    expect(claims).toContain('Hand-written claim');
    expect(claims).toContain('a bootstrapped claim');
    // The appended row got the NEXT fence row number, not a row_num=1 collision.
    const appended = fence.takes.find((t) => t.claim === 'a bootstrapped claim');
    expect(appended?.rowNum).toBe(2);
  });
});
