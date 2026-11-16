/**
 * #9192: v153's activation queues every page for a text-projection rebuild. Search keeps answering from the index an
 * inline Markdown or code page had (built at or after the safe-chunk fence) until that page's rebuild, and stops
 * serving it the moment the page changes. A page indexed before the fence, and the queued rebuild itself, are unchanged.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { addMember, memberIdentity } from '../src/core/access/members.ts';
import { stampIfPageProvenanceComplete } from '../src/core/embed-stale.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { PAGE_PROJECTION_ACTIVATION_SQL } from '../src/core/page-state/projection-schema.ts';
import { projectionBacklog, rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';
import { textRebuildDuration } from '../src/core/page-state/rebuild-estimate.ts';
import { probeProjectionReadiness } from '../src/core/search/projection-readiness.ts';
import { withCallerAccess, __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { ACTIVATION_SERVED_REVISION, currentTextProjectionFilter, servedTextProjectionFilter } from '../src/core/search/safe-chunks.ts';
import { v153 } from '../src/core/schema-migrations/v153-verified-text-projection-activation.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const TEXT = 'The okapi theremin appears in this synthetic note.';
const SLUGS = ['notes/okapi-one', 'notes/okapi-two'];
const vector = (seed: number) => { const v = new Float32Array(1536); v[seed] = 1; return v; };

const statements = (sql: string) => sql.split(';').map(s => s.trim()).filter(Boolean);
/** The activation as v0.51.0.0 through master shipped it: every page out of search until rebuilt. */
const SHIPPED_ACTIVATION = ['UPDATE pages SET text_projection_revision=NULL,embedding_signature=NULL', statements(PAGE_PROJECTION_ACTIVATION_SQL).at(-1)!];
const drain = async (engine: BrainEngine) => { while ((await rebuildPendingPageProjections(engine, 20)).rebuilt > 0) { /* drain */ } };
const count = async (engine: BrainEngine, where: string) =>
  Number((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages p WHERE ${where}`))[0]?.n);

async function activated(run: (engine: BrainEngine) => Promise<void>, databaseUrl?: string, opts: { belowFence?: string; preRevision?: boolean; code?: string; image?: string; extra?: Record<string, { body: string; timeline?: string; frontmatter?: Record<string, unknown> }> } = {}) {
  const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
  try {
    for (const [i, slug] of SLUGS.entries()) {
      await engine.putPage(slug, { type: 'note', title: 'Okapi theremin', compiled_truth: TEXT });
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: TEXT, embedding: vector(i) }]);
    }
    for (const [slug, page] of Object.entries(opts.extra ?? {})) {
      await engine.putPage(slug, { type: 'note', title: 'Okapi theremin', compiled_truth: page.body, ...(page.timeline ? { timeline: page.timeline } : {}), ...(page.frontmatter ? { frontmatter: page.frontmatter } : {}) });
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: TEXT }]);
    }
    if (opts.belowFence) await engine.executeRaw('UPDATE pages SET chunker_version = 3 WHERE slug = $1', [opts.belowFence]);
    if (opts.code) await engine.executeRaw("UPDATE pages SET page_kind = 'code', source_path = NULL WHERE slug = $1", [opts.code]);
    if (opts.image) await engine.executeRaw("UPDATE pages SET page_kind = 'image' WHERE slug = $1", [opts.image]);
    if (opts.preRevision) {
      // Pages written before v150 reach v153 with no knowledge_revision (the upgrade #9192 reported, from v145).
      await engine.executeRaw('ALTER TABLE pages ALTER COLUMN knowledge_revision DROP NOT NULL');
      await engine.executeRaw('ALTER TABLE pages DISABLE TRIGGER USER');
      await engine.executeRaw('UPDATE pages SET knowledge_revision = NULL, text_projection_revision = NULL');
      await engine.executeRaw('ALTER TABLE pages ENABLE TRIGGER USER');
    }
    for (const statement of statements(PAGE_PROJECTION_ACTIVATION_SQL)) await engine.executeRaw(statement);
    await run(engine);
  } finally { await close(); }
}

const SRC = 'source-a';
const ACCESS_PAGES = {
  alice: { slug: 'notes/alice-plan', canary: 'canaryinasalice', fm: 'readable_by: [alice-example]' },
  open: { slug: 'notes/open-plan', canary: 'canaryinasopen', fm: '' },
  gone: { slug: 'notes/gone-plan', canary: 'canaryinasgone', fm: '' },
} as const;
const accessPage = (p: { slug: string; canary: string }, fm: string) => `---\ntype: note\ntitle: ${p.slug}\n${fm}\n---\n# Plan\n\nPlanning notes ${p.canary}.`;

/** Imported pages with readers, activated; `seen(member)` is what that member's search returns (null: the local owner). */
async function accessActivated(run: (engine: BrainEngine, seen: (member: string | null) => Promise<string[]>) => Promise<void>, databaseUrl?: string) {
  const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
  try {
    __resetPrivateVisibilityCacheForTests();
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
    for (const p of Object.values(ACCESS_PAGES)) await importFromContent(engine, p.slug, accessPage(p, p.fm), { sourceId: SRC, noEmbed: true } as never);
    await addMember(engine, 'alice-example');
    await addMember(engine, 'bob-example');
    for (const statement of statements(PAGE_PROJECTION_ACTIVATION_SQL)) await engine.executeRaw(statement);
    const seen = async (member: string | null) => {
      const identity = member ? (await memberIdentity(engine, member)).identity : null;
      const out: string[] = [];
      for (const [key, page] of Object.entries(ACCESS_PAGES)) {
        const call = () => dispatchToolCall(engine, 'search', { query: page.canary, match: 'keyword', fields: 'full' }, { remote: false, sourceId: SRC });
        const reply = identity ? await withCallerAccess({ identity, applyRemoteReadPolicy: true, hidePrivate: true, privateReadableSources: [] }, call) : await call();
        if (reply.content.map(c => c.text).join('\n').includes(page.canary)) out.push(key);
      }
      return out.sort();
    };
    await run(engine, seen);
  } finally { await close(); }
}
const keywordSlugs = async (engine: BrainEngine, query = 'okapi theremin', remote = false) =>
  (await engine.searchKeyword(query, { limit: 10, requireSafeChunks: remote })).map(r => r.slug).sort();
const vectorSlugs = async (engine: BrainEngine, seed: number) => (await engine.searchVector(vector(seed), { limit: 1 })).map(r => r.slug);

test('the estimate follows the measured round trip: 50,000 pages take minutes locally and hours behind a 17 ms pooler', () => {
  expect(textRebuildDuration(50_000, 0.1)).toBe('14 minute(s)');
  expect(textRebuildDuration(50_000, 17.3)).toBe('9 hour(s)');
});

for (const backend of testBackends()) {
  const url = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  describe(`#9192 search keeps answering while the upgrade's rebuild drains (${backend})`, () => {
    test('keyword, safe-chunk and vector search find every page right after activation, with no partial notice', () => activated(async engine => {
      expect((await projectionBacklog(engine)).pending).toBe(2);
      expect(await keywordSlugs(engine)).toEqual(SLUGS);
      expect(await keywordSlugs(engine, 'okapi theremin', true)).toEqual(SLUGS);
      expect(await vectorSlugs(engine, 0)).toEqual([SLUGS[0]!]);
      expect(await vectorSlugs(engine, 1)).toEqual([SLUGS[1]!]);
      expect((await probeProjectionReadiness(engine)).status).toBe('ready');
      const reply = JSON.stringify(await dispatchToolCall(engine, 'search', { query: 'okapi theremin' }, { remote: false }));
      expect(reply).toContain(SLUGS[0]!);
      expect(reply).not.toContain('results may be incomplete');
    }, url), 120_000);

    test('pages from before v150, which reach the activation with no revision, keep answering too', () => activated(async engine => {
      expect((await projectionBacklog(engine)).pending).toBe(2);
      expect(await keywordSlugs(engine)).toEqual(SLUGS);
      expect(await vectorSlugs(engine, 1)).toEqual([SLUGS[1]!]);
    }, url, { preRevision: true }), 120_000);

    test('a page edited after activation leaves search until its rebuild, then answers with the new text', () => activated(async engine => {
      await engine.putPage(SLUGS[0]!, { type: 'note', title: 'Okapi theremin', compiled_truth: 'The okapi now plays a zither.' });
      expect(await keywordSlugs(engine)).toEqual([SLUGS[1]!]);
      while ((await rebuildPendingPageProjections(engine, 20)).rebuilt > 0) { /* drain */ }
      expect(await keywordSlugs(engine, 'zither')).toEqual([SLUGS[0]!]);
      expect((await projectionBacklog(engine)).pending).toBe(0);
      const [row] = await engine.executeRaw<{ sealed: number }>('SELECT count(*)::int AS sealed FROM pages WHERE text_projection_revision = knowledge_revision');
      expect(row?.sealed).toBe(2);
    }, url), 120_000);

    test('a page indexed before the safe-chunk fence stays out of search until it is rebuilt', () => activated(async engine => {
      expect(await keywordSlugs(engine)).toEqual([SLUGS[1]!]);
      expect((await probeProjectionReadiness(engine)).status).toBe('projection_pending');
      while ((await rebuildPendingPageProjections(engine, 20)).rebuilt > 0) { /* drain */ }
      expect(await keywordSlugs(engine)).toEqual(SLUGS);
    }, url, { belowFence: SLUGS[0] }), 120_000);

    test('a page whose rebuild would remove something keeps waiting: facts or takes fences, private-key text, a quarantine marker', () => activated(async engine => {
      const served = await engine.executeRaw<{ slug: string }>(`SELECT slug FROM pages WHERE text_projection_revision = '${ACTIVATION_SERVED_REVISION}'::uuid ORDER BY slug`);
      expect(served.map(r => r.slug)).toEqual(SLUGS);
      expect(await keywordSlugs(engine)).toEqual(SLUGS);
      expect((await probeProjectionReadiness(engine)).status).toBe('projection_pending');
      expect((await projectionBacklog(engine)).pending).toBe(8);
    }, url, { extra: {
      'notes/facts': { body: `${TEXT}\n\n<!--- gbrain:facts:begin -->\n| # | claim |\n|---|---|\n| 1 | okapi |\n<!--- gbrain:facts:end -->` },
      'notes/takes': { body: `${TEXT}\n\n<!--- gbrain:takes:begin -->\nokapi take\n<!--- gbrain:takes:end -->` },
      'notes/key': { body: [TEXT, ['-----BEGIN', ' RSA PRIVATE KEY', '-----'].join(''), 'MIIEexample', ['-----END', ' RSA PRIVATE KEY', '-----'].join('')].join('\n') },
      'notes/quarantined': { body: TEXT, frontmatter: { quarantine: 'junk' } },
      'notes/timeline-key': { body: TEXT, timeline: ['- 2020-01-01: pasted', ['-----BEGIN', ' RSA PRIVATE KEY', '-----'].join(''), 'MIIEexample'].join('\n') },
      'notes/timeline-takes': { body: TEXT, timeline: '- 2020-01-01: noted\n\n<!--- gbrain:takes:begin -->\nokapi take\n<!--- gbrain:takes:end -->' },
    } }), 120_000);

    test('a restricted caller gets no marker page it cannot read, and a soft-deleted marker page is not returned', () => accessActivated(async (engine, seen) => {
      expect(await count(engine, `p.text_projection_revision = '${ACTIVATION_SERVED_REVISION}'::uuid`)).toBe(3);
      expect(await seen(null)).toEqual(['alice', 'gone', 'open']);
      expect(await seen('alice-example')).toEqual(['alice', 'gone', 'open']);
      expect(await seen('bob-example')).toEqual(['gone', 'open']);
      await engine.softDeletePage(ACCESS_PAGES.gone.slug, { sourceId: SRC });
      expect(await seen(null)).toEqual(['alice', 'open']);
      expect(await seen('bob-example')).toEqual(['open']);
    }, url), 120_000);

    test('a page whose readers change before its rebuild leaves search, and afterwards answers only its new readers', () => accessActivated(async (engine, seen) => {
      await importFromContent(engine, ACCESS_PAGES.open.slug, accessPage(ACCESS_PAGES.open, 'readable_by: [alice-example]'), { sourceId: SRC, noEmbed: true } as never);
      const [open] = await engine.executeRaw<{ tpr: string | null }>('SELECT text_projection_revision::text AS tpr FROM pages WHERE slug = $1', [ACCESS_PAGES.open.slug]);
      expect(open?.tpr).not.toBe(ACTIVATION_SERVED_REVISION);
      expect(await seen('bob-example')).toEqual(['gone']);
      await drain(engine);
      expect(await seen('bob-example')).toEqual(['gone']);
      expect(await seen('alice-example')).toEqual(['alice', 'gone', 'open']);
    }, url), 120_000);

    test('a page whose rebuild fails keeps serving its old index and is still counted as waiting', () => activated(async engine => {
      await rebuildPendingPageProjections(engine, 20);
      expect(await engine.executeRaw('SELECT reason FROM page_projection_jobs WHERE slug = $1', [SLUGS[0]])).toEqual([{ reason: 'rebuild_failed' }]);
      expect(await keywordSlugs(engine)).toEqual(SLUGS);
      const backlog = await projectionBacklog(engine);
      expect(backlog.pending).toBe(1);
      expect(backlog.failed).toBe(1);
    }, url, { code: SLUGS[0] }), 120_000);

    test('a brain that already ran the shipped activation moves to this build part-way through its rebuild with no re-run and no refusal', () => activated(async engine => {
      for (const statement of SHIPPED_ACTIVATION) await engine.executeRaw(statement);
      expect((await rebuildPendingPageProjections(engine, 1)).rebuilt).toBe(1);
      const writes: string[] = [];
      const spy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write);
      try { await engine.initSchema(); } finally { spy.mockRestore(); }
      expect(writes.some(w => w.includes('[153]'))).toBe(false);
      expect(await count(engine, `p.text_projection_revision = '${ACTIVATION_SERVED_REVISION}'::uuid`)).toBe(0);
      expect((await keywordSlugs(engine)).length).toBe(1);
      expect((await projectionBacklog(engine)).pending).toBe(1);
      await drain(engine);
      expect(await keywordSlugs(engine)).toEqual(SLUGS);
    }, url), 120_000);

    test('the marker never equals a real revision, and the strict current-projection reads treat a marker page as not current', () => activated(async engine => {
      expect(ACTIVATION_SERVED_REVISION[14]).toBe('0');
      expect(await count(engine, "substr(p.knowledge_revision::text, 15, 1) <> '4'")).toBe(0);
      expect(await count(engine, servedTextProjectionFilter('p'))).toBe(2);
      expect(await count(engine, currentTextProjectionFilter('p'))).toBe(0);
      const stamp = { signature: 'openai:text-embedding-3-small:1536', column: 'embedding' };
      expect(await stampIfPageProvenanceComplete(engine, SLUGS[0]!, 'default', stamp)).toBe(false);
      await drain(engine);
      expect(await count(engine, currentTextProjectionFilter('p'))).toBe(2);
    }, url), 120_000);

    test('an older build reads a marker page as waiting: its search predicate drops it and its readiness predicate counts it', () => activated(async engine => {
      expect(await count(engine, '(p.text_projection_revision = p.knowledge_revision) IS TRUE')).toBe(0);
      expect(await count(engine, 'p.deleted_at IS NULL AND p.text_projection_revision IS DISTINCT FROM p.knowledge_revision')).toBe(2);
      expect((await projectionBacklog(engine)).pending).toBe(2);
    }, url), 120_000);

    test('the readiness probe reads the index of pages waiting for a rebuild, which leaves out pages served from their old index (v317)', () => activated(async engine => {
      const captured: Array<{ sql: string; params?: unknown[] }> = [];
      const recording = { executeRaw: (sql: string, params?: unknown[]) => { captured.push({ sql, params }); return engine.executeRaw(sql, params); } } as unknown as BrainEngine;
      expect((await withEnv({ GBRAIN_PROJECTION_READINESS_CACHE: '0' }, () => probeProjectionReadiness(recording))).status).toBe('ready');
      const probe = captured.find(call => call.sql.includes('IS DISTINCT FROM'));
      expect(probe).toBeDefined();
      const plan = await engine.transaction(async tx => {
        await tx.executeRaw('SET LOCAL enable_seqscan = off');
        return (await tx.executeRaw<Record<string, string>>(`EXPLAIN ${probe!.sql}`, probe!.params)).map(row => Object.values(row)[0]).join('\n');
      });
      expect(plan).toContain('idx_pages_projection_waiting');
    }, url), 120_000);

    test('the v153 handler says which pages stay served and which wait', () => activated(async engine => {
      const writes: string[] = [];
      const spy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write);
      try { await v153.handler!(engine); } finally { spy.mockRestore(); }
      const line = writes.find(w => w.includes('[153]')) ?? '';
      expect(line).toContain('Search keeps answering from the index 1 of them already had; 1 (images, pages indexed before the safe-chunk fence, and pages with a facts or takes fence, private-key text or a quarantine marker) stay out of search until rebuilt.');
      expect(line).toContain('gbrain projections drain');
    }, url, { belowFence: SLUGS[0] }), 120_000);

    test('the v153 estimate times the Markdown and code pages the drain rebuilds, not images', () => activated(async engine => {
      const writes: string[] = [];
      const spy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write);
      try { await v153.handler!(engine); } finally { spy.mockRestore(); }
      const line = writes.find(w => w.includes('[153]')) ?? '';
      expect(line).toContain('3 page(s) queued');
      expect(line).toContain('rebuilding its 2 Markdown and code page(s) takes about');
    }, url, { image: 'notes/okapi-image', extra: { 'notes/okapi-image': { body: TEXT } } }), 120_000);
  });
}
