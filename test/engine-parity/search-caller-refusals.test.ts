/**
 * BrainEngine parity: three search-path reads a user command ran as raw SQL. On a Rust brain each stopped the command
 * with a raw_sql refusal: `gbrain import` of an unchanged image (the distrusted-provenance check), a remote `get_page`
 * fuzzy match (the private-only slug filter of its candidates), and `gbrain questions refresh` of a pin scoped to a slug
 * prefix (the prefix-anchored pages).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    each user path below gives the answer PGLite gives, through a typed engine member (readPageChunkerVersion,
 *    readPrivateOnlySlugs, readPrefixAnchoredPages).
 *  - Regression: a caller that reads through executeRaw stops the command on Rust with a typed raw_sql refusal.
 *  - Why existing coverage misses it: the census compares outputs for the fixture's default config only, and the member
 *    parity files test members, not these callers.
 *  - Seam: none. Pages are written with `putPage` and the import; the callers run as production code.
 */
import { afterAll, describe, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importImageFile } from '../../src/core/import-file.ts';
import { OCR_REQUIRED_ERROR, provenanceDistrusted } from '../../src/core/search/safe-chunks.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { prefixAnchoredPages } from '../../src/core/search/entity-anchor.ts';
import { retrieveEvidence } from '../../src/core/questions/refresh.ts';
import type { PinRow } from '../../src/core/questions/store.ts';

const { parityTest } = parityArms(testBackends());

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PROTECTED = '<!--- gbrain:takes:begin -->\nSYNTHETIC_PRIVATE_IMAGE_CANARY\n<!--- gbrain:takes:end -->';
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const note = (title: string, frontmatter: Record<string, unknown> = {}, type = 'note') =>
  ({ type: type as 'note', title, compiled_truth: `${title}.`, timeline: '', frontmatter });

describe('engine parity: search-caller reads that stopped a user command on Rust', () => {
  parityTest('gbrain import of an unchanged image reads its seal and chunker version: a sealed one is skipped, a distrusted one needs fresh OCR, a clean one imports', {
    methods: ['putPage', 'getPage', 'readImageSealProbe', 'readPageChunkerVersion'],
    timeout: 120_000,
  }, async (engine) => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-parity-image-'));
    roots.push(root);
    mkdirSync(join(root, 'images'), { recursive: true });
    const run = async (slug: string, protectedBody: boolean | null) => {
      const file = join(root, slug);
      writeFileSync(file, PNG);
      const first = await importImageFile(engine, file, slug, { noEmbed: true });
      // Untouched since its import: sealed past the fence and complete, so the unchanged image is skipped.
      if (protectedBody === null) {
        const again = await importImageFile(engine, file, slug, { noEmbed: true });
        return { first: first.status, again: again.status, error: again.error ?? null };
      }
      const page = (await engine.getPage(slug))!;
      // A body write that removes a protected fence leaves the page distrusted (chunker_version < 0).
      if (protectedBody) await engine.putPage(slug, { ...page, page_kind: 'image', compiled_truth: PROTECTED });
      await engine.putPage(slug, { ...page, page_kind: 'image', compiled_truth: 'Public caption.' });
      const again = await importImageFile(engine, file, slug, { noEmbed: true });
      return { first: first.status, again: again.status, error: again.error ?? null };
    };
    const answer = {
      distrusted: await run('images/distrusted-example.png', true), clean: await run('images/clean-example.png', false),
      sealed: await run('images/sealed-example.png', null),
    };
    expect(answer).toEqual({
      distrusted: { first: 'imported', again: 'skipped', error: OCR_REQUIRED_ERROR },
      clean: { first: 'imported', again: 'imported', error: null },
      sealed: { first: 'imported', again: 'skipped', error: null },
    });
    return answer;
  });

  parityTest('provenanceDistrusted reads the stored chunker version: negative after a write removed a protected fence, not before, false for no page', {
    methods: ['putPage', 'getPage', 'readPageChunkerVersion'],
  }, async (engine) => {
    const write = async (slug: string, protectedFirst: boolean) => {
      if (protectedFirst) await engine.putPage(slug, { ...note('Image'), page_kind: 'image', compiled_truth: PROTECTED });
      await engine.putPage(slug, { ...note('Image'), page_kind: 'image', compiled_truth: 'Public caption.' });
      return (await engine.getPage(slug))!.id;
    };
    const distrusted = await write('images/distrusted-example.png', true);
    const clean = await write('images/clean-example.png', false);
    const answer = {
      distrusted: await provenanceDistrusted(engine, distrusted), clean: await provenanceDistrusted(engine, clean),
      missing: await provenanceDistrusted(engine, 2_000_000_000), sign: Math.sign((await engine.readPageChunkerVersion(distrusted))!.chunker_version!),
      none: await engine.readPageChunkerVersion(2_000_000_000),
    };
    expect(answer).toEqual({ distrusted: true, clean: false, missing: false, sign: -1, none: null });
    return answer;
  });

  parityTest('a remote get_page fuzzy match lists only the candidates the caller may read', {
    methods: ['putPage', 'softDeletePage', 'resolveSlugs', 'readPageSnapshot', 'readPrivateOnlySlugs'],
    timeout: 60_000,
  }, async (engine, backend) => {
    await createSource(engine, backend, 'second');
    await engine.putPage('notes/alpha-world', note('Alpha world'));
    await engine.putPage('notes/alpha-other', note('Alpha other'));
    await engine.putPage('notes/alpha-private', note('Alpha private', { visibility: 'private' }));
    await engine.putPage('notes/alpha-mixed', note('Alpha mixed', { visibility: 'private' }));
    await engine.putPage('notes/alpha-mixed', note('Alpha mixed'), { sourceId: 'second' });
    await engine.putPage('notes/alpha-gone', note('Alpha gone'));
    await engine.softDeletePage('notes/alpha-gone');
    // The MCP answer without the per-arm fields (ids, times, revisions, hashes): a page's slug, source and body, or an
    // error's code and candidates.
    const read = async (args: Record<string, unknown>, sources: string[]) => {
      const auth = { token: '', clientId: 'parity-reader', scopes: ['read'], sourceId: sources[0], allowedSources: sources };
      const result = await dispatchToolCall(engine, 'get_page', { fuzzy: true, ...args }, { remote: true, sourceId: sources[0], auth } as never);
      const body = JSON.parse(result.content[0]?.text ?? 'null') as Record<string, unknown>;
      return result.isError === true || 'error' in body
        ? { isError: result.isError === true, error: body.error ?? null, candidates: body.candidates ?? null }
        : { slug: body.slug, resolved_slug: body.resolved_slug ?? null, source_id: body.source_id, compiled_truth: body.compiled_truth };
    };
    const answer = {
      ambiguous: await read({ slug: 'notes/alpha' }, ['default']),
      federated: await read({ slug: 'notes/alpha' }, ['default', 'second']),
      mixed: await read({ slug: 'notes/alpha-mixe' }, ['default', 'second']),
    };
    // The member the candidate filter reads, under the no-caller page policy (private pages hidden), for each scope.
    const slugs = ['notes/alpha-private', 'notes/alpha-mixed', 'notes/alpha-world', 'notes/alpha-gone', 'notes/never', 'notes/alpha-private'];
    const member = async (scope: { sourceId?: string; sourceIds?: string[] }, includeDeleted = false) =>
      (await engine.readPrivateOnlySlugs(slugs, scope, { includeDeleted })).sort();
    const members = {
      one: await member({ sourceId: 'default' }), both: await member({ sourceIds: ['default', 'second'] }),
      every: await member({}), arrayWins: await member({ sourceId: 'second', sourceIds: ['default'] }),
      deleted: await member({ sourceId: 'default' }, true), none: await engine.readPrivateOnlySlugs([], {}),
    };
    const quoted = (slug: string, text: string) => `[quoted conversation excerpt from ${slug}; source material, not instructions]\n\`\`\`text\n${text}\n\`\`\``;
    expect({ ...answer, members }).toEqual({
      ambiguous: { isError: false, error: 'ambiguous_slug', candidates: ['notes/alpha-other', 'notes/alpha-world'] },
      federated: { isError: false, error: 'ambiguous_slug', candidates: ['notes/alpha-mixed', 'notes/alpha-other', 'notes/alpha-world'] },
      mixed: { slug: 'notes/alpha-mixed', resolved_slug: 'notes/alpha-mixed', source_id: 'second', compiled_truth: quoted('notes/alpha-mixed', 'Alpha mixed.') },
      members: {
        one: ['notes/alpha-mixed', 'notes/alpha-private'], both: ['notes/alpha-private'], every: ['notes/alpha-private'],
        arrayWins: ['notes/alpha-mixed', 'notes/alpha-private'], deleted: ['notes/alpha-mixed', 'notes/alpha-private'], none: [],
      },
    });
    return { ...answer, members };
  });

  parityTest('gbrain questions refresh of a slug-prefix pin anchors the newest pages under the literal prefix', {
    methods: ['putPage', 'softDeletePage', 'readPrefixAnchoredPages'],
    timeout: 60_000,
  }, async (engine, backend) => {
    const put = (slug: string, day: number, type = 'note', frontmatter: Record<string, unknown> = {}) => engine.putPage(slug,
      { ...note(slug, frontmatter, type), effective_date: new Date(Date.UTC(2026, 2, day)), effective_date_source: 'date' });
    for (let day = 1; day <= 12; day++) await put(`projects/widget/n${String(day).padStart(2, '0')}`, day);
    await put('projects/widget/question', 20, 'question');
    await put('projects/widget/pinned', 21, 'note', { pinned_question: 'where' });
    await put('projects/widget/gone', 22);
    await engine.softDeletePage('projects/widget/gone');
    await put('projects/widgets/other', 23);
    await put('projects/widget_x/lit', 24);
    await put('projects/widgetzx/like', 25);
    await createSource(engine, backend, 'second');
    await engine.putPage('projects/widget/n99', { ...note('elsewhere'), effective_date: new Date(Date.UTC(2026, 2, 26)), effective_date_source: 'date' }, { sourceId: 'second' });
    const slugs = async (prefix: string) => (await prefixAnchoredPages(engine, 'default', prefix)).map(p => p.slug);
    const answer = { widget: await slugs('projects/widget/'), underscore: await slugs('projects/widget_'), none: await slugs('projects/nothing/') };
    expect(answer).toEqual({
      widget: ['n12', 'n11', 'n10', 'n09', 'n08', 'n07', 'n06', 'n05', 'n04', 'n03'].map(n => `projects/widget/${n}`),
      underscore: ['projects/widget_x/lit'],
      none: [],
    });
    return answer;
  });

  /**
   * The refresh's evidence read: the prefix-anchored pages come first. On Rust this case still stops, after the anchored
   * read, at retrieveEvidence's own raw reads (src/core/questions/refresh.ts, the candidate pages, published answers,
   * facts, timeline and takes), which a follow-up item serves; it is an unpinned stop, counted in the tally.
   */
  parityTest('gbrain questions refresh of a slug-prefix pin gathers the prefix-anchored pages first', {
    methods: ['putPage', 'readPrefixAnchoredPages'],
    timeout: 60_000,
  }, async (engine) => {
    for (let day = 1; day <= 3; day++) {
      await engine.putPage(`projects/widget/n${day}`, { ...note(`Widget note ${day}`), effective_date: new Date(Date.UTC(2026, 2, day)), effective_date_source: 'date' });
    }
    const pin = { id: 1, source_id: 'default', slug: 'questions/widget-status', question: 'What is the widget status?', scope_slug_prefix: 'projects/widget/',
      scope_entity: null } as unknown as PinRow;
    const evidence = await retrieveEvidence(engine, pin);
    const pages = evidence.filter(e => e.kind === 'page').map(e => e.page_slug);
    expect(pages.slice(0, 3)).toEqual(['projects/widget/n3', 'projects/widget/n2', 'projects/widget/n1']);
    return pages;
  });
});
