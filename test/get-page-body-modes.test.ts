/**
 * Large pages (Wave A read contract): get_page body modes, selectors, cursors
 * and the privacy boundary of windowed reads.
 *
 * Every partial read is a slice of the read projection (withdrawal-overlaid,
 * fence-overlaid, sanitized, credential-projected); it never carries
 * compiled_truth / timeline / content. Hermetic in-memory PGLite.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { pageDocument } from '../src/core/page-window/document.ts';
import { decodeCursor } from '../src/core/page-window/window.ts';
import { encodedFrameBytes } from '../src/core/egress-budget.ts';
import { normalizeLoweredClaim } from '../src/core/facts/withdrawal-schema.ts';

let engine: PGLiteEngine;
const get_page = operations.find(o => o.name === 'get_page')!;

function ctx(overrides: Partial<OperationContext> = {}): OperationContext {
  return { engine: engine as any, config: {} as any, logger: { info() {}, warn() {}, error() {} } as any, dryRun: false,
    remote: true, transport: 'stdio', sourceId: 'default', ...overrides } as OperationContext;
}
const local = () => ctx({ remote: false, transport: undefined });

async function put(slug: string, body: string, timeline = '', frontmatter: Record<string, unknown> = {}) {
  const r = await importFromContent(engine, slug, serializeMarkdown(frontmatter, body, timeline, { type: 'note', title: slug, tags: [] }),
    { sourceId: 'default', noEmbed: true, forceRechunk: true });
  expect(r.status).toBe('imported');
}

async function get(c: OperationContext, params: Record<string, unknown>): Promise<Record<string, any>> {
  return await get_page.handler(c, params) as Record<string, any>;
}

async function projection(slug: string): Promise<Buffer> {
  const snap = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  return pageDocument({ compiled_truth: snap!.page.compiled_truth, timeline: snap!.page.timeline }).bytes;
}

async function expectCode(p: Promise<unknown>, code: string): Promise<OperationError> {
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(OperationError);
    const err = e as OperationError;
    expect((err as any).canonical ?? err.code).toBe(code);
    return err;
  }
  throw new Error(`expected ${code}`);
}

/** A conversation log: dated lines, many repeated, well past the 256 KB inline size. */
function conversation(lines: number): string {
  const out: string[] = ['# Log with acme-example', ''];
  for (let i = 0; i < lines; i++) {
    const day = String(1 + (i % 28)).padStart(2, '0');
    out.push(i % 7 === 0 ? `**alice-example:** ok sounds good` : `**bob-example:** 2026-03-${day} line ${i} about the widget plan, needle-${i}`);
  }
  return out.join('\n');
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Wave A inline behaviour: pin segmented storage off (segmented reads of get_page and gbrain get are lane 2a's).
  await engine.setConfig('pages.segmented_storage', 'off');
  await put('notes/small', 'A small page about acme-example.');
  await put('logs/big', conversation(9000));
  await put('logs/mid', conversation(6000));
}, 120_000);

afterAll(async () => { await engine.disconnect(); }, 60_000);

describe('mode resolution', () => {
  test('a small page under auto keeps the full shape', async () => {
    const r = await get(ctx(), { slug: 'notes/small' });
    expect(r.compiled_truth).toContain('A small page');
    expect(r.window).toBeUndefined();
  });

  test('a page over the inline size under auto is an outline plus a first window, never a body field', async () => {
    const r = await get(ctx(), { slug: 'logs/big' });
    expect(r.compiled_truth).toBeUndefined();
    expect(r.timeline).toBeUndefined();
    expect(r.content).toBeUndefined();
    expect(r.body).toBe('outline');
    expect(r.truncated).toBe(true);
    expect(r.size.total_bytes).toBe((await projection('logs/big')).length);
    expect(r.size.total_lines).toBeGreaterThan(9000);
    expect(r.window.byte_start).toBe(0);
    expect(r.window.text.length).toBeGreaterThan(0);
    expect(typeof r.next_cursor).toBe('string');
    expect(r.outline.entries.length).toBeGreaterThan(0);
  });

  test('trusted local reads and include_content stay whole', async () => {
    const r = await get(local(), { slug: 'logs/big' });
    expect(typeof r.compiled_truth).toBe('string');
    const c = await get(ctx(), { slug: 'logs/big', include_content: true });
    expect(typeof c.content).toBe('string');
    const only = await get(ctx(), { slug: 'logs/big', include_content: true, content_only: true });
    expect(typeof only.content).toBe('string');
    expect(only.compiled_truth).toBeUndefined();
  });

  test("gbrain's thin client naming no mode gets the whole page", async () => {
    const r = await get(ctx({ thinClient: true, transport: 'http' }), { slug: 'logs/big' });
    expect(typeof r.compiled_truth).toBe('string');
  });

  test('body none returns revision, size and chunk counts without text', async () => {
    const r = await get(ctx(), { slug: 'logs/mid', body: 'none' });
    expect(typeof r.revision).toBe('string');
    expect(r.window).toBeUndefined();
    expect(r.compiled_truth).toBeUndefined();
    expect(r.chunks.total).toBeGreaterThan(10);
    expect(r.size.total_bytes).toBeGreaterThan(256 * 1024);
  });

  test('conflicting selectors and modes are invalid_params', async () => {
    await expectCode(get(ctx(), { slug: 'logs/big', lines: { from: 1, count: 5 }, bytes: { offset: 0, length: 10 } }), 'invalid_params');
    await expectCode(get(ctx(), { slug: 'logs/big', body: 'outline', lines: { from: 1, count: 5 } }), 'invalid_params');
    await expectCode(get(ctx(), { slug: 'logs/big', body: 'window', include_content: true }), 'invalid_params');
    await expectCode(get(ctx(), { slug: 'logs/big', lines: { from: 0, count: 5 } }), 'invalid_params');
    await expectCode(get(ctx(), { slug: 'logs/big', body: 'everything' }), 'invalid_params');
  });
});

describe('windows', () => {
  test('cursor paging covers the projection exactly, in order, line-aligned', async () => {
    const doc = await projection('logs/big');
    const parts: Buffer[] = [];
    let r = await get(ctx(), { slug: 'logs/big', body: 'window', max_bytes: 30_000 });
    for (let i = 0; i < 1000; i++) {
      parts.push(Buffer.from(r.window.text, 'utf8'));
      expect(Buffer.byteLength(r.window.text)).toBeLessThanOrEqual(30_000);
      if (r.window.byte_end < doc.length) expect(doc[r.window.byte_end - 1]).toBe(0x0a);
      if (!r.next_cursor) break;
      r = await get(ctx(), { slug: 'logs/big', cursor: r.next_cursor });
    }
    expect(Buffer.concat(parts).equals(doc)).toBe(true);
  });

  test('lines and bytes selectors snap to line starts', async () => {
    const doc = await projection('logs/big');
    const r = await get(ctx(), { slug: 'logs/big', lines: { from: 100, count: 3 } });
    expect(r.window.line_start).toBe(100);
    expect(r.window.line_end).toBe(102);
    expect(r.window.text.split('\n').filter(Boolean)).toHaveLength(3);
    const b = await get(ctx(), { slug: 'logs/big', bytes: { offset: 5003, length: 2000 } });
    expect(b.window.byte_start).toBeLessThanOrEqual(5003);
    expect(b.window.byte_start === 0 || doc[b.window.byte_start - 1] === 0x0a).toBe(true);
    expect(b.window.text).toBe(doc.subarray(b.window.byte_start, b.window.byte_end).toString('utf8'));
  });

  test('a stale cursor is revision_changed with the same offset in its fix', async () => {
    await put('logs/moving', conversation(6000));
    const r = await get(ctx(), { slug: 'logs/moving', body: 'window' });
    const offset = decodeCursor(r.next_cursor)!.offset;
    await put('logs/moving', conversation(6001));
    const err = await expectCode(get(ctx(), { slug: 'logs/moving', cursor: r.next_cursor }), 'revision_changed');
    expect(JSON.stringify(err.fix?.mcp?.arguments)).toContain(`"offset":${offset}`);
  });

  test('a cursor for another page is invalid_params', async () => {
    const r = await get(ctx(), { slug: 'logs/big', body: 'window' });
    await put('logs/other', conversation(6000));
    await expectCode(get(ctx(), { slug: 'logs/other', cursor: r.next_cursor }), 'invalid_params');
  });

  test('a long single line pages with forced cuts on code points', async () => {
    await put('blobs/one-line', '😀é'.repeat(200_000));
    const r = await get(ctx(), { slug: 'blobs/one-line', body: 'window', max_bytes: 1001 });
    expect(r.window.forced_cut).toBe(true);
    expect(r.window.text).not.toContain('\uFFFD');
    expect(Buffer.byteLength(r.window.text)).toBeLessThanOrEqual(1001);
  });

  test('view markdown pages the round-trip content and its sha256 verifies the whole', async () => {
    const whole = (await get(ctx(), { slug: 'logs/big', include_content: true })).content as string;
    const parts: string[] = [];
    let r = await get(ctx(), { slug: 'logs/big', body: 'window', view: 'markdown', bytes: { offset: 0, length: 200_000 } });
    const sha = r.size.sha256;
    for (let i = 0; i < 100; i++) {
      expect(r.content).toBeUndefined();
      parts.push(r.window.text);
      if (!r.next_cursor) break;
      r = await get(ctx(), { slug: 'logs/big', body: 'window', view: 'markdown', cursor: r.next_cursor });
    }
    expect(parts.join('')).toBe(whole);
    expect(createHash('sha256').update(parts.join(''), 'utf8').digest('hex')).toBe(sha);
  });
});

describe('around_chunk_id', () => {
  test('centers on the exact stored span, even on repeated text', async () => {
    const para = 'the same message repeated in this conversation again and again. '.repeat(30);
    await put('logs/repeats', Array.from({ length: 190 }, () => para).join('\n\n'));
    const chunks = await engine.getChunks('logs/repeats', { sourceId: 'default' } as any);
    expect(chunks.length).toBeGreaterThan(20);
    const doc = await projection('logs/repeats');
    const target = chunks[Math.floor(chunks.length * 0.9)];
    expect(typeof target.projected_byte_start).toBe('number');
    const r = await get(ctx(), { slug: 'logs/repeats', around_chunk_id: target.id, context_lines: 0 });
    expect(r.anchor).toBe('stored_span');
    expect(r.chunk_span.byte_start).toBe(target.projected_byte_start);
    expect(r.window.byte_start).toBeLessThanOrEqual(target.projected_byte_start!);
    expect(r.window.byte_end).toBeGreaterThanOrEqual(target.projected_byte_end!);
    expect(r.window.byte_start).toBeGreaterThan(doc.length * 0.8);
  });

  test('whitespace the chunker folds still resolves to the exact stored span', async () => {
    const para = (i: number) => `para ${i}:   spaced\t\ttext   with  runs    of whitespace   \t and trailing   `.repeat(12);
    await put('logs/spaced', Array.from({ length: 300 }, (_, i) => para(i)).join('\n   \n\t\n  \n'));
    const chunks = await engine.getChunks('logs/spaced', { sourceId: 'default' } as any);
    const target = chunks[chunks.length - 2];
    expect(target.chunk_text).not.toBe((await projection('logs/spaced')).subarray(target.projected_byte_start!, target.projected_byte_end!).toString('utf8'));
    const r = await get(ctx(), { slug: 'logs/spaced', around_chunk_id: target.id, context_lines: 0 });
    expect(r.anchor).toBe('stored_span');
    expect(r.window.text.replace(/\s+/g, '')).toContain(target.chunk_text.replace(/\s+/g, ''));
  });

  test('timeline chunks resolve inside the timeline', async () => {
    await put('logs/with-timeline', 'Overview of acme-example.', Array.from({ length: 2000 }, (_, i) => `- 2026-01-${String(1 + i % 28).padStart(2, '0')}: event ${i} happened at the widget plant`).join('\n'));
    const chunks = (await engine.getChunks('logs/with-timeline', { sourceId: 'default' } as any)).filter(c => c.chunk_source === 'timeline');
    const target = chunks[chunks.length - 1];
    const r = await get(ctx(), { slug: 'logs/with-timeline', around_chunk_id: target.id, max_bytes: 4000 });
    expect(r.anchor).toBe('stored_span');
    expect(r.chunk_span.byte_start).toBeGreaterThanOrEqual(r.size.timeline_byte_start);
    expect(r.window.text.replace(/\s+/g, '')).toContain(target.chunk_text.replace(/\s+/g, '').slice(0, 200));
  });

  test('a chunk id that is not on the page is revision_changed', async () => {
    const other = (await engine.getChunks('notes/small', { sourceId: 'default' } as any))[0];
    await expectCode(get(ctx(), { slug: 'logs/big', around_chunk_id: other.id }), 'revision_changed');
    await expectCode(get(ctx(), { slug: 'logs/big', around_chunk_id: 987654321 }), 'revision_changed');
  });

  test('a chunk without a span and with ambiguous text returns only the chunk itself', async () => {
    const para = 'identical paragraph text for the ambiguity case, repeated verbatim. '.repeat(30);
    await put('logs/legacy', Array.from({ length: 200 }, () => para).join('\n\n'));
    await engine.executeRaw(`UPDATE content_chunks SET projected_byte_start = NULL, projected_byte_end = NULL
      WHERE page_id = (SELECT id FROM pages WHERE slug = 'logs/legacy')`);
    const chunk = (await engine.getChunks('logs/legacy', { sourceId: 'default' } as any))[5];
    const r = await get(ctx(), { slug: 'logs/legacy', around_chunk_id: chunk.id });
    expect(r.anchor).toBe('chunk_only');
    expect(r.window.text).toBe(chunk.chunk_text);
    expect(r.window.byte_start).toBeUndefined();
    expect(r.next_cursor).toBeUndefined();
  });
});

describe('privacy boundary (remote windows are slices of the sanitized projection)', () => {
  const PRIVATE = 'PRIVATE-TAKE-SECRET-alice-example';
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `public line ${i} about acme-example widgets and plans`).join('\n');
  const takes = `## Takes\n\n<!--- gbrain:takes:begin -->\n| # | claim | kind | who | weight | since | source |\n|---|-------|------|-----|--------|-------|--------|\n${Array.from({ length: 50 }, (_, i) => `| ${i + 1} | ${PRIVATE} ${i} | take | alice-example | 0.8 | 2026-04 | note |`).join('\n')}\n<!--- gbrain:takes:end -->`;

  test('a window whose raw offset starts inside a balanced takes fence holds no take', async () => {
    const body = `${filler(4000)}\n\n## Hidden heading in prose\n\n${takes}\n\n${filler(4000)}`;
    await put('people/fenced', body);
    const snap = await engine.readPageSnapshot('people/fenced', { sourceId: 'default' });
    const rawOffset = Buffer.byteLength(snap!.page.compiled_truth.slice(0, snap!.page.compiled_truth.indexOf(PRIVATE)), 'utf8');
    const doc = await projection('people/fenced');
    expect(doc.toString('utf8')).not.toContain(PRIVATE);
    for (const sel of [{ bytes: { offset: rawOffset, length: 20_000 } }, { bytes: { offset: Math.max(0, rawOffset - 50), length: 400_000 } }, { lines: { from: 4005, count: 200 } }]) {
      const r = await get(ctx(), { slug: 'people/fenced', ...sel });
      expect(r.window.text).not.toContain(PRIVATE);
      expect(r.window.text).not.toContain('gbrain:takes');
    }
    let r = await get(ctx(), { slug: 'people/fenced', body: 'window', max_bytes: 50_000 });
    for (let i = 0; i < 100 && r; i++) {
      expect(r.window.text).not.toContain(PRIVATE);
      r = r.next_cursor ? await get(ctx(), { slug: 'people/fenced', cursor: r.next_cursor }) : null as any;
    }
  });

  test('a malformed (unterminated) fence hides everything after its opener', async () => {
    const body = `${filler(5000)}\n\n<!--- gbrain:takes:begin -->\n| 1 | ${PRIVATE} | take | alice-example | 0.8 | 2026-04 | note |\n${filler(3000)}`;
    await put('people/malformed', body);
    const r = await get(ctx(), { slug: 'people/malformed', bytes: { offset: 300_000, length: 100_000 } });
    expect(r.window.text).not.toContain(PRIVATE);
    const all = await get(ctx(), { slug: 'people/malformed', body: 'window', max_bytes: 1_000_000 });
    expect(all.window.text).not.toContain(PRIVATE);
  });

  test('outline metadata never names a heading inside a protected fence', async () => {
    const hiddenHeading = '## SECRET-HEADING-alice-example';
    const facts = `<!--- gbrain:facts:begin -->\n\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n| 1 | private fact about alice-example | fact | 1.0 | private | high | 2026-01-01 |  | note |  |\n<!--- gbrain:facts:end -->`;
    const body = `# Top\n\n${filler(3000)}\n\n## Section two\n\n${filler(3000)}\n\n<!--- gbrain:takes:begin -->\n${hiddenHeading}\n<!--- gbrain:takes:end -->\n\n${facts}\n\n${filler(1000)}`;
    await put('people/outline', body);
    const r = await get(ctx(), { slug: 'people/outline', body: 'outline' });
    const json = JSON.stringify(r.outline);
    expect(json).not.toContain('SECRET-HEADING');
    expect(json).not.toContain('private fact');
    expect(r.outline.entries.map((e: any) => e.heading)).toContain('Section two');
  });

  test('a world fact withdrawn in the ledger is not in any window', async () => {
    const claim = 'acme-example withdrawn world fact claim';
    const facts = `<!--- gbrain:facts:begin -->\n\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n| 1 | ${claim} | fact | 1.0 | world | high | 2026-01-01 |  | note |  |\n| 2 | acme-example kept world fact | fact | 1.0 | world | high | 2026-01-01 |  | note |  |\n<!--- gbrain:facts:end -->`;
    await put('companies/withdrawn', `${filler(3000)}\n\n${facts}\n\n${filler(3000)}`);
    const before = await get(ctx(), { slug: 'companies/withdrawn', body: 'window', max_bytes: 1_000_000 });
    expect(before.window.text).toContain(claim);
    await engine.executeRaw(`INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash) VALUES ('default', 'world', 'companies/withdrawn', $1)`,
      [createHash('sha256').update(normalizeLoweredClaim(claim)).digest('hex')]);
    const after = await get(ctx(), { slug: 'companies/withdrawn', body: 'window', max_bytes: 1_000_000 });
    expect(after.window.text).not.toContain(claim);
    expect(after.window.text).toContain('kept world fact');
    const outline = await get(ctx(), { slug: 'companies/withdrawn', body: 'outline' });
    expect(JSON.stringify(outline)).not.toContain(claim);
  });
});

describe('egress', () => {
  test('body full over the connection cap is page_too_large_for_inline with a windowed fix', async () => {
    await put('logs/huge', conversation(30_000));
    const err = await expectCode(get(ctx({ transport: 'http' }), { slug: 'logs/huge', body: 'full' }), 'page_too_large_for_inline');
    expect(err.fix?.mcp?.arguments).toMatchObject({ slug: 'logs/huge', body: 'outline' });
    const ok = await get(ctx({ transport: 'stdio' }), { slug: 'logs/huge', body: 'full' });
    expect(typeof ok.compiled_truth).toBe('string');
    await expectCode(get(ctx({ transport: 'http', thinClient: true }), { slug: 'logs/huge' }), 'page_too_large_for_inline');
  });

  test('escape-heavy text shrinks the window until the encoded frame fits the cap', async () => {
    await put('blobs/escapes', Array.from({ length: 4000 }, (_, i) => `${i} ${'"\\'.repeat(60)}`).join('\n'));
    const r = await get(ctx({ transport: 'http' }), { slug: 'blobs/escapes', body: 'window', max_bytes: 1_000_000 });
    const frame = encodedFrameBytes({ content: [{ type: 'text', text: JSON.stringify(r) }] });
    expect(frame).toBeLessThanOrEqual(1024 * 1024);
    expect(Buffer.byteLength(r.window.text)).toBeGreaterThan(64 * 1024);
    expect(typeof r.next_cursor).toBe('string');
  });

  test('windows stay under the cap the connection allows', async () => {
    const r = await get(ctx({ transport: 'http' }), { slug: 'logs/huge', body: 'window', max_bytes: 5_000_000 });
    expect(Buffer.byteLength(r.window.text)).toBeLessThanOrEqual(1024 * 1024);
  });
});
