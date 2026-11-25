/**
 * BrainEngine parity — doctor's page, source and receipt lists name text keys in byte order on every engine and locale.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the volunteer-channel counts (scoped and unscoped), the raw-provenance sample, the unpriced-model groups,
 *    the truncated-extraction groups, the restorable atom retirements by source, the title-duplicate pairs, the undated
 *    facts pages, the schema-pack source grading, the unchanged-body atom recheck (which atoms fall inside its 200-group cut), and the two
 *    function-search-path reads (the doctor check and the hardening's pre-count) return the same order on every engine arm (PGLite
 *    always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1): byte order, as PGLite and the Rust
 *    store sort. The volunteer-channel counts are seeded through the typed event insert on every engine.
 *  - Regression: an en_US Postgres sorted these keys by its locale, which skips punctuation (`ab` before `a-z`) and
 *    folds case, so the channels, slugs, models, kinds and sources doctor printed came back in another order than on
 *    PGLite and Rust brains, and the atom recheck cut its 200 groups at a different place.
 *  - Why existing coverage misses it: the cases used ids that sort the same in every locale, and CI's Postgres runs
 *    in C.UTF-8. Every case here mixes keys such as `a-z`, `ab`, `a.b` and `a_b`; run it against an en_US Postgres to see
 *    it fail.
 *  - Seam: none. The pages go through putPage, the derivation receipts through upsertSegmentDerivations, the volunteer
 *    events through insertVolunteerEvents and the extraction receipts through writePageExtractionReceipt; the
 *    retirement stamps are the rows the writers leave.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { BYTE_IDS, BYTE_SLUGS, MIXED_IDS, MIXED_SLUGS, byteOrder } from '../helpers/byte-order.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { DoctorContext } from '../../src/commands/doctor/context.ts';
import { checkVolunteerChannels, rawProvenanceCheck } from '../../src/commands/doctor/checks/core-health.ts';
import { derivationUnpricedModelEntry } from '../../src/commands/doctor/checks/derivation-pricing.ts';
import { extractionInputTruncatedEntry } from '../../src/commands/doctor/checks/extraction-input.ts';
import { atomRetirementsRestorableCheck } from '../../src/commands/doctor/checks/atom-retirements.ts';
import { personTitleDuplicatesEntry } from '../../src/commands/doctor/checks/entity-duplicates.ts';
import { factsUndatedLines } from '../../src/commands/doctor/checks/facts-pages.ts';
import { checkSchemaPackConsistency } from '../../src/commands/doctor/schema-pack-checks.ts';
import { unchangedBodyAtoms } from '../../src/commands/doctor/checks/atom-body-recheck.ts';
import { functionSearchPathProblems } from '../../src/commands/doctor/checks/function-search-path.ts';
import { legacySearchPathFunctions } from '../../src/core/function-search-path.ts';
import { ATOM_REEXTRACT_RETIRED_BY } from '../../src/core/persistence/atom-retirement-hold.ts';
import { contentHash } from '../../src/core/utils.ts';

const { parityTest } = parityArms(testBackends());

/** Two sources whose ids sort differently by byte and by en_US. */
const SOURCES = ['ab', 'a-z'];
const SOURCES_BYTES = ['a-z', 'ab'];

const ctxFor = (engine: BrainEngine, extra: Record<string, unknown> = {}) =>
  ({ engine, orphanRatioSourceId: undefined, progress: { heartbeat() {} }, ...extra }) as unknown as DoctorContext;

/**
 * These checks catch a store's refusal and report health unknown, so a Rust brain would not stop on the typed raw_sql
 * refusal by itself: the case reads through raw SQL first, which does.
 */
const rawProbe = (engine: BrainEngine) => engine.executeRaw('SELECT 1 AS one');

describe('doctor lists text keys by byte', () => {
  parityTest('volunteer channels list by byte name, scoped to sources and brain-wide', {
    methods: ['putPage', 'insertVolunteerEvents'],
  }, async (engine, backend) => {
    for (const source of SOURCES) await createSource(engine, backend, source);
    for (const [i, channel] of MIXED_IDS.entries()) {
      const sourceId = SOURCES[i % 2]!;
      await engine.putPage(`notes/n${i}`, { type: 'note', title: `N${i}`, compiled_truth: `Note ${i}.`, timeline: '' }, { sourceId });
      await engine.insertVolunteerEvents([{ source_id: sourceId, slug: `notes/n${i}`, confidence: 0.9, match_arm: 'exact', rationale: '', channel }]);
    }
    const unscoped = await checkVolunteerChannels(engine);
    const scoped = await checkVolunteerChannels(engine, { sourceIds: SOURCES });
    const out = { unscoped: Object.keys((unscoped.details as any).channels), scoped: Object.keys((scoped.details as any).channels) };
    expect(out).toEqual({ unscoped: [...BYTE_IDS], scoped: [...BYTE_IDS] });
    expect(unscoped.message).toContain(`push-context channels active (7d): ${BYTE_IDS.map(c => `${c}=1`).join(', ')}`);
    return out;
  });

  parityTest('the raw-provenance sample names synthesized pages by byte slug', {
    methods: ['putPage'],
  }, async (engine) => {
    for (const slug of MIXED_SLUGS) {
      await engine.putPage(`synth/${slug}`, { type: 'synthesis', title: slug, compiled_truth: `Synthesis ${slug}.`, timeline: '' });
    }
    const check = await rawProvenanceCheck(engine);
    const named = /e\.g\. ([^.]*(?:\.[^ ][^.]*)*)\. Fix:/.exec(check.message)?.[1];
    expect(check.status).toBe('warn');
    expect(named).toBe(BYTE_SLUGS.map(s => `synth/${s}`).join(', '));
    return named;
  });

  parityTest('unpriced models of equal page count list by byte model id', {
    methods: ['putPage', 'upsertSegmentDerivations'],
  }, async (engine) => {
    const models = MIXED_IDS.map(id => `acme:unpriced-${id}`);
    for (const [i, model] of models.entries()) {
      const page = await engine.putPage(`notes/priced-${i}`, { type: 'note', title: `Page ${i}`, compiled_truth: `Body ${i}.`, timeline: '' });
      await engine.upsertSegmentDerivations([{ pageId: Number(page.id), kind: 'synopsis', occurrenceId: 1, version: 1,
        segmentSha256: new Uint8Array(32).fill(0xaa), contextHash: new Uint8Array(32).fill(0xbb), state: 'skipped', output: null,
        receipt: { kind: 'unpriced_model', model } }]);
    }
    const [check] = await derivationUnpricedModelEntry.run({ engine } as unknown as DoctorContext) as Array<{ status: string; details: any }>;
    const listed = check!.details.models.map((m: { model: string }) => m.model);
    expect(check!.status).toBe('warn');
    expect(listed).toEqual(byteOrder(models));
    return listed;
  });

  parityTest('truncated-extraction groups list by byte kind within a pipeline', {
    methods: ['putPage', 'readPageIdInSource', 'writePageExtractionReceipt'],
  }, async (engine) => {
    for (const [i, kind] of MIXED_IDS.entries()) {
      await engine.putPage(`notes/cut-${i}`, { type: 'note', title: `Cut ${i}`, compiled_truth: `Body ${i}.`, timeline: '' });
      const pageId = (await engine.readPageIdInSource(`notes/cut-${i}`, 'default'))!;
      await engine.writePageExtractionReceipt(pageId, 'extract_atoms', 1, { kind });
    }
    const checks = await extractionInputTruncatedEntry.run(ctxFor(engine)) as Array<{ name: string; details: any }>;
    const groups = checks.find(c => c.name === 'extraction_input_truncated')!.details.groups.map((g: { kind: string }) => g.kind);
    expect(groups).toEqual([...BYTE_IDS]);
    return groups;
  });

  parityTest('restorable atom retirements list by byte source id', {
    methods: ['putPage', 'softDeletePage'],
  }, async (engine, backend) => {
    for (const source of SOURCES) {
      await createSource(engine, backend, source);
      await engine.putPage('notes/origin', { type: 'note', title: 'Origin', compiled_truth: 'Origin body.', timeline: '' }, { sourceId: source });
      await engine.putPage('atoms/retired', { type: 'atom' as never, title: 'Retired', compiled_truth: 'Retired atom.', timeline: '',
        frontmatter: { retired_by: ATOM_REEXTRACT_RETIRED_BY, retired_at: '2026-01-01T00:00:00Z', source_slug: 'notes/origin', source_hash: 'abc123' } }, { sourceId: source });
      await engine.softDeletePage('atoms/retired', { sourceId: source });
    }
    const check = await atomRetirementsRestorableCheck(engine, SOURCES);
    const out = (check.details as any).source_ids;
    expect(out).toEqual(SOURCES_BYTES);
    expect(check.message).toContain(`(${SOURCES_BYTES.map(s => `${s}: 1 from 1 origin(s)`).join('; ')})`);
    return out;
  });

  parityTest('title-duplicate pairs list by byte stub slug', {
    methods: ['putPage', 'listAllSources'],
  }, async (engine) => {
    const person = (slug: string, title: string) => engine.putPage(slug, { title, type: 'person', compiled_truth: `${title}.` } as never);
    await person('people/ann-zed', 'Ann Zed');
    await person('people/anne-able', 'Anne Able');
    await person('people/dr-anne-able', 'Dr. Anne Able');
    await person('people/dr-ann-zed', 'Dr. Ann Zed');
    const [check] = await personTitleDuplicatesEntry.run(ctxFor(engine)) as Array<{ status: string; details: any }>;
    const pairs = check!.details.pairs.map((p: { stub: string; canonical: string }) => [p.stub, p.canonical]);
    expect(pairs).toEqual([['people/dr-ann-zed', 'people/ann-zed'], ['people/dr-anne-able', 'people/anne-able']]);
    return pairs;
  });

  parityTest('undated facts pages list by byte source id then slug', {
    methods: ['putPage'],
  }, async (engine, backend) => {
    for (const source of SOURCES) {
      await createSource(engine, backend, source);
      for (const slug of MIXED_SLUGS) {
        await engine.putPage(`facts/${slug}`, { type: 'facts', title: `Facts ${slug}`, compiled_truth: 'True things.\n\n- an undated line\n', timeline: '' }, { sourceId: source });
      }
    }
    const check = await factsUndatedLines(engine);
    const pages = (check.details as any).pages.map((p: { source_id: string; slug: string }) => `${p.source_id}:${p.slug}`);
    expect(pages).toEqual(SOURCES_BYTES.flatMap(s => BYTE_SLUGS.map(slug => `${s}:facts/${slug}`)));
    return pages;
  });

  parityTest('schema-pack consistency grades sources in byte id order', {
    methods: ['putPage'],
  }, async (engine, backend) => {
    for (const source of SOURCES) {
      await createSource(engine, backend, source);
      await engine.putPage('notes/odd', { type: 'zz-undeclared-example' as never, title: 'Odd', compiled_truth: 'Odd page.', timeline: '' }, { sourceId: source });
    }
    const check = await checkSchemaPackConsistency(engine, { sourceIds: SOURCES });
    const graded = (check.details as any).per_source.map((g: { source_id: string }) => g.source_id);
    expect(graded).toEqual(SOURCES_BYTES);
    return graded;
  });

  parityTest('the unchanged-body recheck cuts its 200 groups in byte order', {
    methods: ['putPage', 'createVersion', 'getPage', 'listBodyRecheckGroups', 'readBodyRecheckPage', 'listBodyRecheckVersions'],
  }, async (engine) => {
    const body = { type: 'note' as const, title: 'Origin', compiled_truth: 'Origin body.', timeline: '' };
    // The edition the matching atom was extracted from: a version whose hash starts with a lower-case letter, which
    // sorts after the upper-case filler hashes below by byte and before them under en_US. The page is written with the
    // nonce, snapshotted, then written back without it, so no live page holds that hash.
    let nonce = 0;
    let edition = contentHash({ ...body, frontmatter: { nonce }, tags: [] });
    while (!/^[a-f]/.test(edition)) edition = contentHash({ ...body, frontmatter: { nonce: ++nonce }, tags: [] });
    await engine.putPage('notes/origin', { ...body, frontmatter: { nonce } });
    await engine.createVersion('notes/origin');
    await engine.putPage('notes/origin', body);
    const atom = (slug: string, title: string, hash: string) => engine.putPage(slug, { type: 'atom' as never, title, compiled_truth: `${title}.`, timeline: '',
      frontmatter: { source_hash: hash, source_slug: 'notes/origin', extracted_at: '2026-01-01T00:00:00Z' } });
    for (let g = 1; g <= 200; g++) await atom(`atoms/filler-${g}`, `Filler ${g}`, `Fz${String(g).padStart(14, '0')}`);
    await atom('atoms/match', 'Match', edition.slice(0, 16));
    // The cut keeps the 200 upper-case filler hashes; the match sorts after them by byte, so it is not rechecked.
    const cut = (await engine.listBodyRecheckGroups()).map(g => `${g.sh}:${g.n}`);
    expect(cut).toEqual(Array.from({ length: 200 }, (_, g) => `Fz${String(g + 1).padStart(14, '0')}:1`));
    // The page and the edition the recheck would compare: the live inline body, and the one snapshot with the nonce.
    const originId = Number((await engine.getPage('notes/origin'))!.id);
    const page = await engine.readBodyRecheckPage(originId);
    expect(page).toEqual({ body_storage: 'inline', compiled_truth: body.compiled_truth, timeline: body.timeline });
    const versions = (await engine.listBodyRecheckVersions(originId)).map(v => ({ title: v.title, type: v.type, compiled_truth: v.compiled_truth,
      frontmatter: typeof v.frontmatter === 'string' ? JSON.parse(v.frontmatter) : v.frontmatter }));
    expect(versions).toEqual([{ title: body.title, type: body.type, compiled_truth: body.compiled_truth, frontmatter: { nonce } }]);
    const unchanged = await unchangedBodyAtoms(engine);
    expect(unchanged).toBe(0);
    return { cut, page, versions, unchanged };
  });

  parityTest('function-search-path reads list overloads by byte signature', {
    methods: ['executeRaw'], requires: 'raw_sql',
  }, async (engine) => {
    const overloads = ['public.gbrain_fts_input(text[])', 'public.gbrain_fts_input(text, text)'];
    await engine.executeRaw(`CREATE FUNCTION public.gbrain_fts_input(a text[]) RETURNS text LANGUAGE sql SET search_path = pg_catalog AS $$ SELECT 'a' $$`);
    await engine.executeRaw(`CREATE FUNCTION public.gbrain_fts_input(a text, b text) RETURNS text LANGUAGE sql SET search_path = pg_catalog AS $$ SELECT 'b' $$`);
    try {
      const problems = (await functionSearchPathProblems(engine)).functions.filter(sig => sig.startsWith('gbrain_fts_input('));
      const legacy = (await legacySearchPathFunctions(engine)).filter(sig => sig.startsWith('gbrain_fts_input('));
      const out = { problems, legacy };
      expect(out).toEqual({
        problems: ['gbrain_fts_input(text,text)', 'gbrain_fts_input(text[])'],
        legacy: ['gbrain_fts_input(text,text)', 'gbrain_fts_input(text[])'],
      });
      return out;
    } finally {
      for (const sig of overloads) await engine.executeRaw(`DROP FUNCTION IF EXISTS ${sig}`);
    }
  });
});
