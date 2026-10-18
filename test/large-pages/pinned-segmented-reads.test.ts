/**
 * Wave B PR 2 fix lane F (F1): a segmented read that follows an authorization reads the authorized revision or
 * nothing.
 *
 * 1. Protects: remote get_page (none, outline, auto, a bytes window, the markdown view, around_chunk_id, the whole-body
 *    refusal), fetch, assemble_evidence windows and the entity card's identity excerpt authorize a page snapshot and
 *    then open its segmented body. A page made private (frontmatter visibility plus a new body generation holding a
 *    secret) between that authorization and the segment read, a visibility-only flip while the segments are being
 *    read, and a trust demotion below the caller's min_trust (no revision change) all refuse the raced read
 *    (revision_changed or page_not_found; evidence falls back to the hit chunk; the card shows no excerpt), and a
 *    fresh read is page_not_found. An unchanged page reads normally under the pin.
 * 2. Fails when: openSegmentedBody reads the live generation instead of the snapshot's (b9787c6a9 returned the new
 *    private body's text to the raced reader), a pinned read is returned without confirming the page is still at the
 *    pinned revision, or the trust floor is not re-checked after the read.
 *    N5: manifest rows the reader cannot see (hidden through the engine, as a pages-only RLS policy would) or a gap in the
 *    live manifest refuse with page_body_rows_unreadable instead of reading as an empty or truncated body (b9787c6a9
 *    answered total_bytes 0).
 *    N8: remote get_versions reports a segmented version's read-projection size (total_bytes), never its stored
 *    body_bytes.
 * 3. The race is forced through a one-shot hook on the engine: before openSegmentedBody's page-row query (`open`) or
 *    before the first segment-text read (`read`), the hook writes the page; no timing. Runs on PGLite, and on Postgres
 *    when DATABASE_URL is set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { withCoordinatedWrite, withTrustBackfill } from '../../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';
import { readCardIdentity } from '../../src/core/verbs/entity-card-identity.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { importSegmented } from '../helpers/segmented-privacy-fixture.ts';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExport } from '../../src/commands/export.ts';
import { materializeSegmentedBody } from '../../src/core/page-body/ingest.ts';
import { storedBodyDigests } from '../../src/core/page-body/body-digests.ts';
import { readBodyLedger } from '../../src/core/page-body/segment-ledger.ts';
import { withEnv } from '../helpers/with-env.ts';

const SECRET = ['zz', 'secret', 'pinned', 'token'].join('');
const NEEDLE = 'zzpinneedle';
const op = (name: string) => operations.find(o => o.name === name)!;
let engine: BrainEngine;

const ctx = (): OperationContext => ({ engine, config: {} as GBrainConfig, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true,
  sourceId: 'default', emitResponseMeta: () => {}, transport: 'http', auth: { token: 'fixture', clientId: 'pin-client',
    principal: { kind: 'oauth_client', id: 'pin-client' }, scopes: ['read'], sourceId: 'default', allowedSources: ['default'] } } as unknown as OperationContext);
const call = async (name: string, params: Record<string, unknown>) => await op(name).handler(ctx(), params) as Record<string, any>;

function filler(bytes: number, tag: string): string {
  const parts: string[] = [];
  for (let i = 0, n = 0; n < bytes; i++) {
    const part = `## Section ${tag} ${i}\n\n${`Public notes on launch planning and roadmap review for week ${i}. `.repeat(30)}\n\n`;
    parts.push(part);
    n += part.length;
  }
  return parts.join('');
}
const publicBody = (tag: string) => `Nickname: Copper Pin\n\n${filler(700_000, tag)}\n${NEEDLE} marks the middle once\n\n${filler(700_000, `${tag}b`)}`;
const content = (body: string, extra = '') => `---\ntitle: Pinned probe\ntype: note\n${extra}---\n\n${body}`;

/** The authorized page becomes private with a new body generation whose lead holds SECRET. */
const privateRewrite = (slug: string) => async () => {
  await importFromContent(engine, slug, content(`Codename: ${SECRET} Alpha\n\n${SECRET} is the private body now.\n\n${filler(1_300_000, 'private')}`, 'visibility: private\n'),
    { sourceId: 'default', noEmbed: true });
};
const visibilityOnly = (slug: string) => async () => {
  await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter || '{"visibility":"private"}'::jsonb WHERE source_id='default' AND slug=$1`, [slug]);
};

type Outcome = { ok: boolean; code?: string; text: string };
const OPEN_SQL = 'SELECT id, source_id, slug, body_storage, body_generation';
/** Runs `flip` once, before openSegmentedBody's page-row query (`open`) or the first segment-text read (`read`); reports whether it fired. */
async function raced(seam: 'open' | 'read', flip: () => Promise<void>, read: () => Promise<unknown>): Promise<{ fired: boolean; outcome: Outcome }> {
  let fired = false;
  const exec = engine.executeRaw;
  const texts = engine.readSegmentTexts;
  const fire = async () => { fired = true; await flip(); };
  // A transaction's engine inherits from `engine` (Object.create on PGLite), so the hooks keep the caller's `this`.
  if (seam === 'open') {
    engine.executeRaw = (async function (this: BrainEngine, sql: string, params?: unknown[]) {
      if (!fired && sql.startsWith(OPEN_SQL)) await fire();
      return exec.call(this, sql, params);
    }) as typeof engine.executeRaw;
  } else {
    engine.readSegmentTexts = (async function (this: BrainEngine, ...args: Parameters<typeof engine.readSegmentTexts>) {
      if (!fired) await fire();
      return texts.apply(this, args);
    }) as typeof engine.readSegmentTexts;
  }
  try {
    const outcome = await read().then((r): Outcome => ({ ok: true, text: JSON.stringify(r) }),
      (e: { canonical?: string; code?: string; message?: string; detail?: string }): Outcome => ({ ok: false, code: e.canonical ?? e.code, text: `${e.message} ${e.detail ?? ''}` }));
    return { fired, outcome };
  } finally {
    engine.executeRaw = exec;
    engine.readSegmentTexts = texts;
  }
}

const home = mkdtempSync(join(tmpdir(), 'gbrain-pinned-reads-'));
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

/** `gbrain export --dir out`; a non-zero exit throws with what it printed. */
async function quietExport(out: string): Promise<void> {
  const { log, error } = console;
  const exit = process.exit;
  const messages: string[] = [];
  console.log = console.error = (...args: unknown[]) => { messages.push(args.join(' ')); };
  process.exit = ((code: number) => { throw new Error(`EXIT:${code} ${messages.join('\n')}`); }) as never;
  try { await withEnv({ GBRAIN_HOME: home }, () => runExport(engine, ['--dir', out])); } finally { console.log = log; console.error = error; process.exit = exit; }
}

const refused = (outcome: Outcome) => ({ ok: outcome.ok, code: outcome.code, leaked: outcome.text.includes(SECRET) });

async function freshReadIsMissing(slug: string) {
  const fresh = await call('get_page', { slug, body: 'none' }).then(() => null, (e: { canonical?: string; code?: string }) => e.canonical ?? e.code);
  expect(fresh).toBe('page_not_found');
}

for (const kind of testBackends()) {
  describe(`segmented reads pinned to the authorized revision (${kind})`, () => {
    let close: () => Promise<void>;
    let n = 0;
    const page = async () => {
      const slug = `notes/pinned-${++n}`;
      const id = await importSegmented(engine, slug, content(publicBody(`p${n}`)));
      return { slug, id };
    };
    const needleChunk = async (pageId: number) => (await engine.executeRaw<{ id: number; chunk_text: string }>(
      'SELECT id, chunk_text FROM content_chunks WHERE page_id=$1 AND strpos(chunk_text, $2) > 0 ORDER BY chunk_index LIMIT 1', [pageId, NEEDLE]))[0]!;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
    }, 120_000);
    afterAll(async () => { await close(); });
    beforeEach(async () => { await engine.executeRaw('DELETE FROM pages'); });

    const shapes: Array<[string, Record<string, unknown>]> = [
      ['none', { body: 'none' }], ['outline', { body: 'outline' }], ['auto', {}], ['bytes window', { body: 'window', bytes: { offset: 0, length: 20_000 } }],
      ['markdown view', { body: 'window', view: 'markdown', bytes: { offset: 0, length: 20_000 } }], ['whole-body refusal', { body: 'full' }],
    ];
    for (const [label, params] of shapes) {
      test(`get_page ${label}: a page made private with a new body between authorization and the read is refused`, async () => {
        const { slug } = await page();
        const { fired, outcome } = await raced('open', privateRewrite(slug), () => call('get_page', { slug, ...params }));
        expect(fired).toBe(true);
        expect(refused(outcome)).toEqual({ ok: false, code: 'revision_changed', leaked: false });
        await freshReadIsMissing(slug);
      }, 240_000);
    }

    test('get_page around_chunk_id: the raced read is refused', async () => {
      const { slug, id } = await page();
      const hit = await needleChunk(id);
      const { fired, outcome } = await raced('open', privateRewrite(slug), () => call('get_page', { slug, around_chunk_id: Number(hit.id) }));
      expect(fired).toBe(true);
      expect(refused(outcome)).toEqual({ ok: false, code: 'revision_changed', leaked: false });
    }, 240_000);

    test('get_page window: a visibility flip while the segments are read refuses the result', async () => {
      const { slug } = await page();
      const { fired, outcome } = await raced('read', visibilityOnly(slug), () => call('get_page', { slug, body: 'window', bytes: { offset: 600_000, length: 20_000 } }));
      expect(fired).toBe(true);
      expect(refused(outcome)).toEqual({ ok: false, code: 'revision_changed', leaked: false });
      await freshReadIsMissing(slug);
    }, 240_000);

    test('get_page window: a trust demotion below min_trust (no revision change) is re-checked and reads as missing', async () => {
      const { slug, id } = await page();
      await engine.transaction(tx => withTrustBackfill(tx, () => tx.executeRaw("UPDATE pages SET trust_tier='operator_curated' WHERE id=$1", [id])));
      const params = { slug, body: 'window', bytes: { offset: 0, length: 20_000 }, min_trust: 'agent_written' };
      expect((await call('get_page', params)).window.text).toContain('Copper Pin');
      const [before] = await engine.executeRaw<{ revision: string }>('SELECT knowledge_revision::text AS revision FROM pages WHERE id=$1', [id]);
      const demote = async () => { await engine.executeRaw("UPDATE pages SET trust_tier='external_untrusted' WHERE id=$1", [id]); };
      const { fired, outcome } = await raced('open', demote, () => call('get_page', params));
      expect(fired).toBe(true);
      expect((await engine.executeRaw<{ revision: string }>('SELECT knowledge_revision::text AS revision FROM pages WHERE id=$1', [id]))[0]!.revision).toBe(before!.revision);
      expect(refused(outcome)).toEqual({ ok: false, code: 'page_not_found', leaked: false });
    }, 240_000);

    test('fetch: the raced window is refused', async () => {
      const { slug } = await page();
      const { fired, outcome } = await raced('open', privateRewrite(slug), () => call('fetch', { id: slug }));
      expect(fired).toBe(true);
      expect(refused(outcome)).toEqual({ ok: false, code: 'revision_changed', leaked: false });
    }, 240_000);

    test('assemble_evidence: the raced window falls back to the authorized hit chunk', async () => {
      const { slug, id } = await page();
      const hit = await needleChunk(id);
      const { fired, outcome } = await raced('open', privateRewrite(slug),
        () => call('assemble_evidence', { hits: [{ source_id: 'default', slug, chunk_id: Number(hit.id) }], return_unit: 'window', return_window: 2, token_budget: 30_000 }));
      expect(fired).toBe(true);
      expect(outcome.ok).toBe(true);
      expect(outcome.text.includes(SECRET)).toBe(false);
      const [block] = JSON.parse(outcome.text).results as Array<{ chunk_text: string; delivered: { unit: string; fallback_reason?: string } }>;
      expect({ unit: block!.delivered.unit, reason: block!.delivered.fallback_reason }).toEqual({ unit: 'chunk', reason: 'segment_read_failed' });
      expect(block!.chunk_text).toBe(hit.chunk_text);
    }, 240_000);

    test('entity card excerpt: a raced lead read shows nothing of the new body', async () => {
      const { slug } = await page();
      const { fired, outcome } = await raced('open', privateRewrite(slug),
        () => readCardIdentity(engine, 'default', { slug, title: 'Pinned probe', compiled_truth: null }, { excludePrivate: true, aka: [] }));
      expect(fired).toBe(true);
      expect(outcome.ok).toBe(true);
      expect(outcome.text.includes(SECRET)).toBe(false);
    }, 240_000);

    // N5: a role that sees the page row but not its manifest rows (a pages-only RLS policy or grant), or rows missing.
    const ROWS_SQL = 'SELECT m.seq, m.occurrence_id';
    test('manifest rows hidden from the reader refuse the read with page_body_rows_unreadable, never an empty body', async () => {
      const { slug } = await page();
      const exec = engine.executeRaw;
      engine.executeRaw = (async function (this: BrainEngine, sql: string, params?: unknown[]) {
        return sql.startsWith(ROWS_SQL) ? [] : exec.call(this, sql, params);
      }) as typeof engine.executeRaw;
      try {
        for (const params of [{ body: 'none' }, { body: 'window', bytes: { offset: 0, length: 20_000 } }, { body: 'outline' }]) {
          const outcome = await call('get_page', { slug, ...params }).then(r => ({ code: 'ok', total: r.size?.total_bytes }), (e: { canonical?: string; code?: string }) => ({ code: e.canonical ?? e.code }));
          expect({ params, outcome }).toEqual({ params, outcome: { code: 'page_body_rows_unreadable' } });
        }
      } finally {
        engine.executeRaw = exec;
      }
    }, 240_000);

    test('a gap in the live manifest refuses the read with page_body_rows_unreadable', async () => {
      const { slug, id } = await page();
      await engine.executeRaw('DELETE FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL AND gen_to IS NULL AND seq=(SELECT max(seq) / 2 FROM page_body_manifest WHERE page_id=$1 AND gen_to IS NULL)', [id]);
      const outcome = await call('get_page', { slug, body: 'window', bytes: { offset: 0, length: 20_000 } }).then(() => 'ok', (e: { canonical?: string; code?: string }) => e.canonical ?? e.code);
      expect(outcome).toBe('page_body_rows_unreadable');
    }, 240_000);

    test('a live manifest that lost its trailing row: export, materialize and the stored body digest refuse, never a short body', async () => {
      const { slug, id } = await page();
      const intact = join(home, `intact-${kind}`);
      await quietExport(intact);
      expect(existsSync(join(intact, `${slug}.md`))).toBe(true);
      await engine.executeRaw(`DELETE FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL AND gen_to IS NULL
        AND seq=(SELECT max(seq) FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL AND gen_to IS NULL)`, [id]);
      const short = join(home, `short-${kind}`);
      const exported = await quietExport(short).then(() => 'ok', (e: Error) => e.message);
      expect(exported).toContain(`Page ${slug} (source default): the segment rows readable here do not cover`);
      expect(existsSync(join(short, `${slug}.md`))).toBe(false);
      const code = (e: { canonical?: string; code?: string }) => e.canonical ?? e.code;
      expect(await materializeSegmentedBody(engine, id, 'default').then(() => 'ok', code)).toBe('page_body_rows_unreadable');
      expect(await storedBodyDigests(engine, id, await readBodyLedger(engine, 'default', slug)).then(() => 'ok', code)).toBe('page_body_rows_unreadable');
    }, 240_000);

    // N8: get_versions tells a remote caller a segmented version's projected size, never its stored body_bytes.
    test('remote get_versions reports a segmented version by its read projection size, not the stored body_bytes', async () => {
      const slug = `notes/pinned-versions-${++n}`;
      const takes = `<!--- gbrain:takes:begin -->\n${'Hidden take about pricing strategy. '.repeat(8000)}\n<!--- gbrain:takes:end -->\n`;
      const id = await importSegmented(engine, slug, content(`${publicBody(`v${n}`)}\n\n${takes}`));
      await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.createVersion(slug, { sourceId: 'default' }), TEST_WRITE_ATTRIBUTION));
      const projected = (await call('get_page', { slug, body: 'none' })).size.total_bytes as number;
      const [stored] = await engine.executeRaw<{ body_bytes: number }>('SELECT body_bytes FROM pages WHERE id=$1', [id]);
      expect(projected).toBeLessThan(Number(stored!.body_bytes));
      const [meta] = await call('get_versions', { slug }) as unknown as Array<Record<string, unknown>>;
      expect(meta!.body_storage).toBe('segmented');
      expect(meta!.body_bytes).toBeUndefined();
      expect(meta!.total_bytes).toBe(projected);
      const [full] = await call('get_versions', { slug, include_body: true }) as unknown as Array<Record<string, any>>;
      expect(full!.body_bytes).toBeUndefined();
      expect(full!.body_ref.total_bytes).toBe(projected);
      expect(JSON.stringify([meta, full])).not.toContain(String(stored!.body_bytes));
    }, 240_000);

    test('an unchanged page reads normally under the pin on every path', async () => {
      const { slug, id } = await page();
      const none = await call('get_page', { slug, body: 'none' });
      expect(none.body_storage).toBe('segmented');
      expect(none.size.total_bytes).toBeGreaterThan(1_300_000);
      expect((await call('get_page', { slug, body: 'outline' })).outline.entries.length).toBeGreaterThan(0);
      expect((await call('get_page', { slug })).window.text).toContain('Copper Pin');
      let r = await call('get_page', { slug, body: 'window', max_bytes: 400_000 });
      const parts = [r.window.text as string];
      while (r.next_cursor) { r = await call('get_page', { slug, cursor: r.next_cursor }); parts.push(r.window.text); }
      expect(Buffer.byteLength(parts.join(''))).toBe(none.size.total_bytes);
      expect(parts.join('')).toContain(NEEDLE);
      expect((await call('get_page', { slug, body: 'window', view: 'markdown', bytes: { offset: 0, length: 20_000 } })).window.text).toContain('Copper Pin');
      const hit = await needleChunk(id);
      expect((await call('get_page', { slug, around_chunk_id: Number(hit.id) })).window.text).toContain(NEEDLE);
      const refusal = await call('get_page', { slug, body: 'full' }).then(() => null, (e: { code?: string; detail?: string }) => e);
      expect(refusal?.code).toBe('page_body_segmented');
      expect(JSON.parse(refusal!.detail!).total_bytes).toBe(none.size.total_bytes);
      expect((await call('fetch', { id: slug })).text).toContain('Copper Pin');
      const evidence = await call('assemble_evidence', { hits: [{ source_id: 'default', slug, chunk_id: Number(hit.id) }], return_unit: 'window', return_window: 2, token_budget: 30_000 });
      expect(evidence.results[0].delivered.unit).toBe('window');
      expect(evidence.results[0].chunk_text).toContain(NEEDLE);
      const card = await readCardIdentity(engine, 'default', { slug, title: 'Pinned probe', compiled_truth: null }, { excludePrivate: true, aka: [] });
      expect(card.identity_excerpt).toContainEqual({ slug, line: 'Nickname: Copper Pin' });
    }, 300_000);
  });
}
