/**
 * BrainEngine parity — slugs in one normal form: lowercase, then Unicode NFC (normalizeSlug, src/core/utils.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 *    GBRAIN_TEST_RUST_ARM=1), `putPage` stores a decomposed (NFD) slug in NFC, get_page answers a capitalised
 *    or decomposed spelling of a stored slug with that page, and the shared link extractor turns an NFD
 *    wikilink into the NFC slug the engine stored. A put_page by the exact decomposed spelling a page is still
 *    stored under is refused with the same text (detail legacy_slug_spelling); nothing moves and no twin appears. A
 *    delete_page, add_tag, remove_tag, add_timeline_entry, edit_page and append_page by the decomposed spelling a page is stored under
 *    change that row in place (the same answers as on a normalized slug), and no twin appears.
 *    A put by the stored decomposed spelling is refused whether or not a composed twin exists. A read of a slug that no stored page
 *    spells exactly finds the stored spelling that normalizeSlug maps to it (also `Unicode/CAFÉ-İ` for `cafe\u0301-i\u0307`),
 *    and rows in another source never use up the candidates a readable source holds.
 *    A read that finds no page by any exact spelling, and two stored spellings that normalize to the asked slug, is refused.
 *  - Regression: an engine that keeps the caller's NFD bytes (two pages that print the same name), or an op
 *    path that looks the raw spelling up and answers page_not_found for `People/Alice-Example`.
 *  - Why existing coverage misses it: every parity case writes and reads lowercase NFC slugs.
 *  - Seam: none. Real engines; get_page runs through the registry operation.
 *
 * Rust arm known stops (each case asserts the exact Rust answer, then rethrows or throws the typed refusal):
 *  - ambiguity refusal: member `executeRaw`, capability `raw_sql` (Rust raw-sql area): the case stores two capitalised
 *    rows by renaming them, which needs raw SQL; and the Rust store lowercases every slug it stores or reads, so it can hold
 *    neither capitalised spelling. Rust must keep a stored slug's capitals and read a slug exactly as sent for the refusal
 *    (built in TS from `executeRaw` over pages) to be reachable.
 *  - delete_page (and so restore_page after it) by the stored spelling: member `executeRaw`, capability `raw_sql`: the
 *    origin-carry read before the delete (originOf, src/core/repair/origin-carry.ts) is raw SQL the store does not serve,
 *    and delete_page refuses on it before anything is written, since restore_page meets raw SQL too (clearOwedPurges,
 *    src/core/persistence/derived-origin-hold.ts) and a soft delete that landed could not be undone.
 *  - append_page by the stored spelling: preparation meets raw SQL the store does not serve (inlineRegions,
 *    src/core/page-body/tail-digest.ts), so the write ends failed with engine_capability_missing and nothing publishes.
 *    add_tag, remove_tag, add_timeline_entry and edit_page land first.
 *  - writes by a capital-stored spelling: member `putPage` (Rust pages area): a put lowercases the slug, so only a seed
 *    can store a capital spelling; an exact read of a capital spelling the store does not hold answers nothing, as on
 *    PGLite, and one it holds (seeded) refuses (member `readPageSnapshot`, capability `pages`), so a put by it stops
 *    before it writes a lowercase twin.
 *  - NFC storage: member `putPage` (Rust pages area, gbrain-store pages.rs `validate_slug`): the Rust store
 *    lowercases a slug but does not compose it to NFC, so an NFD slug is stored as NFD and the NFC read
 *    misses it. Rust must compose to NFC in `validate_slug` and in its lowercased read lookups.
 *  - the ontology/takes case and the final-review reads (a Unicode-expansion spelling, out-of-scope rows crowding the
 *    candidates) store their rows by renaming them, which stops at `executeRaw` / `raw_sql`.
 * The put_page refusals of a stored decomposed spelling (with and without a composed twin) answer on Rust as on PGLite:
 * the Rust store keeps the NFD bytes a caller sends, so the case stores the old spelling directly.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { extractPageLinks } from '../../src/core/link-extraction.ts';
import { capabilityMissing } from '../../src/core/rust-engine/errors.ts';
import { randomUUID } from 'node:crypto';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { runTakes } from '../../src/commands/takes.ts';

const arms = parityArms(testBackends());
// Write operations start a persistence consumer keyed on the engine the case receives (the harness's recording
// wrapper), which the harness reset does not stop. Stop it when the case ends, so its projection and effect work
// cannot run into the next case's reset (a Postgres deadlock on `DELETE FROM sources` under the stress gate).
const parityTest: typeof arms.parityTest = (name, opts, scenario) => arms.parityTest(name, opts, async (engine, ...rest) => {
  try { return await scenario(engine, ...rest); } finally { await disposePersistenceConsumer(engine); }
});

const NFC_CAFE = 'notes/café';
const NFC_ZOE = 'people/zoë-example';
const NFD_ZOE = 'people/zoë-example';
const LEGACY_REFUSAL = (stored: string, composed: string) => `Page ${stored} is stored under an older decomposed Unicode spelling of its name, so a put by that spelling is refused and nothing was changed. `
  + `To move the page to the normal spelling ${composed}, preview gbrain repair slug-spelling --source default, then run the apply command it prints after the owner agrees; until then the page cannot be replaced by put.`;
const AMBIGUOUS_REFUSAL = (asked: string, decomposed: string, composed: string) => `The slug "${asked}" is ambiguous: this brain stores two pages whose slugs read the same, "${decomposed}" (decomposed, with capitals) and "${composed}" (composed, with capitals), and "${asked}" is neither of them exactly.`;
// A Rust write ends on the first store member the engine does not serve. readPersistenceBrainId (import part A), the
// local writer row (import part B) and the put_page admission read (ADMISSION_SOURCE_SQL in persistence/page-mutations.ts,
// import part E) are served, so put_page runs. restore_page and append_page still meet a raw SQL read in preparation
// (clearOwedPurges in persistence/derived-origin-hold.ts; inlineRegions in page-body/tail-digest.ts) and end failed with this text.
const RUST_JOURNAL_STOP =
  "This brain's engine does not support executeRaw yet (it needs the raw_sql capability), so nothing ran.";
const RUST_RAW_SQL_STOP =
  "This brain's engine does not support executeRaw yet (it needs the raw_sql capability), so nothing ran.";

function ctx(engine: BrainEngine): OperationContext {
  return { engine, config: { engine: engine.kind, embedding_disabled: true } as never, remote: false, sourceId: 'default',
    dryRun: false, logger: { info() {}, warn() {}, error() {} } } as OperationContext;
}

/**
 * On Rust, delete_page refuses before it writes: restore_page meets raw SQL the store does not serve (clearOwedPurges,
 * src/core/persistence/derived-origin-hold.ts), so a soft delete it let land could not be undone. The page stays live at
 * the revision read before the delete.
 */
async function expectRustDeleteRefusedBeforeWrite(engine: BrainEngine, slug: string, revision: string, e: unknown): Promise<void> {
  const page = await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true });
  expect({ code: (e as { code?: unknown }).code, message: (e as Error).message, live: page?.page.deleted_at == null, revision: page?.revision })
    .toEqual({ code: 'engine_capability_missing', message: RUST_RAW_SQL_STOP, live: true, revision });
}

describe('engine parity: slug normal form', () => {
  parityTest('get_page reads a capitalised or decomposed spelling of the stored slug', { methods: ['putPage', 'readPageSnapshot'] }, async (engine) => {
    await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Alice.', timeline: '' });
    await engine.putPage(NFC_CAFE, { type: 'note', title: 'Cafe', compiled_truth: 'Coffee.', timeline: '' });
    const reads = [];
    for (const asked of ['People/Alice-Example', 'notes/café', 'NOTES/CAFÉ']) {
      const page = await operationsByName.get_page!.handler(ctx(engine), { slug: asked }) as { slug: string; title: string };
      reads.push({ asked, slug: page.slug, title: page.title });
    }
    expect(reads.map(r => r.slug)).toEqual(['people/alice-example', NFC_CAFE, NFC_CAFE]);
    return reads;
  });

  parityTest('pages-01: a page written once opens by a mixed-case and by a decomposed-accent spelling of its slug, with the same page on every arm', { methods: ['putPage', 'readPageSnapshot'] }, async (engine) => {
    await engine.putPage('people/charlie-example', { type: 'person', title: 'Charlie Example', compiled_truth: 'Charlie.', timeline: '' });
    await engine.putPage('places/caf\u00e9-example', { type: 'note', title: 'Cafe Example', compiled_truth: 'Coffee.', timeline: '' });
    const reads: Array<{ asked: string; slug: string; title: string }> = [];
    for (const asked of ['People/Charlie-Example', 'places/cafe\u0301-example']) {
      const page = await operationsByName.get_page!.handler(ctx(engine), { slug: asked }) as { slug: string; title: string };
      reads.push({ asked, slug: page.slug, title: page.title });
    }
    expect(reads).toEqual([
      { asked: 'People/Charlie-Example', slug: 'people/charlie-example', title: 'Charlie Example' },
      { asked: 'places/cafe\u0301-example', slug: 'places/caf\u00e9-example', title: 'Cafe Example' },
    ]);
    return reads;
  });

  parityTest('putPage stores an NFD slug in NFC, and an NFD wikilink names that page', { methods: ['putPage', 'getPage'] }, async (engine, backend) => {
    const stored = await engine.putPage(NFD_ZOE, { type: 'person', title: 'Zoe', compiled_truth: 'Zoe.', timeline: '' });
    const extracted = await extractPageLinks('people/hal-example', `Hal knows [[${NFD_ZOE}]].`, {}, 'person', { resolve: async () => null });
    const targets = extracted.candidates.map(c => c.targetSlug);
    const found = await engine.getPage(targets[0]!);
    if (backend === 'rust') {
      // The exact Rust difference today: the NFD bytes are stored, so the NFC read misses the page.
      expect({ stored: stored.slug, targets, found: found?.slug ?? null }).toEqual({ stored: NFD_ZOE, targets: [NFC_ZOE], found: null });
      throw capabilityMissing('pages', 'putPage (a slug in Unicode NFC)', 'partial');
    }
    expect({ stored: stored.slug, targets, found: found?.slug ?? null }).toEqual({ stored: NFC_ZOE, targets: [NFC_ZOE], found: NFC_ZOE });
    return { stored: stored.slug, targets, found: found?.slug ?? null };
  });
  parityTest('a put by the stored decomposed spelling of a page is refused with the same text, and nothing changes', { methods: ['putPage', 'readPageSnapshot'] }, async (engine, backend) => {
    const stored = 'notes/legacy-cafe\u0301';
    const composed = 'notes/legacy-caf\u00e9';
    // A page written before writes composed slugs. The Rust store still keeps the NFD bytes a caller sends (the stop
    // pinned above), so it stores one directly; the TS engines compose, so the row is moved back to the old spelling.
    if (backend === 'rust') await engine.putPage(stored, { type: 'note', title: 'Legacy', compiled_truth: 'Old.', timeline: '' });
    else {
      await engine.putPage(composed, { type: 'note', title: 'Legacy', compiled_truth: 'Old.', timeline: '' });
      await engine.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2', [stored, composed]);
    }
    const before = await engine.readPageSnapshot(stored, { sourceId: 'default', includeDeleted: true });
    const answers: Array<{ code: unknown; detail: unknown; message: string }> = [];
    for (const extra of [{}, { expected_revision: before!.revision }]) {
      try {
        await operationsByName.put_page!.handler(ctx(engine), { slug: stored, content: '---\ntype: note\ntitle: Legacy\n---\nNew.\n', request_id: randomUUID(), ...extra });
        answers.push({ code: null, detail: null, message: 'written' });
      } catch (e) {
        answers.push({ code: (e as { code?: unknown }).code, detail: (e as { detail?: unknown }).detail, message: (e as Error).message });
      }
    }
    const after = await engine.readPageSnapshot(stored, { sourceId: 'default', includeDeleted: true });
    const twin = await engine.readPageSnapshot(composed, { sourceId: 'default', includeDeleted: true });
    const result = { answers, unchanged: after?.revision === before?.revision && after?.page.compiled_truth === before?.page.compiled_truth, twin: twin?.page.slug ?? null };
    const refusal = { code: 'invalid_params', detail: 'legacy_slug_spelling', message: LEGACY_REFUSAL(stored, composed) };
    expect(result).toEqual({ answers: [refusal, refusal], unchanged: true, twin: null });
    return result;
  });
  parityTest('two pages stored under spellings of one slug: a read that finds neither exactly is refused with both named, byte for byte', { methods: ['putPage', 'getPage'] }, async (engine, backend) => {
    const nfd = 'Notes/Ambig-Cafe\u0301';
    const nfc = 'Notes/Ambig-Caf\u00e9';
    const asked = 'notes/ambig-cafe\u0301';
    // Both rows carry capitals, so the lowercase the caller sent matches neither exactly and neither normalizes to it.
    const store = async (slug: string, title: string) => {
      await engine.putPage('notes/ambig-seed', { type: 'note', title, compiled_truth: 'Body.', timeline: '' });
      await engine.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2', [slug, 'notes/ambig-seed']);
    };
    try { await store(nfd, 'Decomposed'); await store(nfc, 'Composed'); } catch (e) {
      if (backend === 'rust') expect((e as Error).message).toBe(RUST_RAW_SQL_STOP);
      throw e;
    }
    let answer: { code: unknown; detail: unknown; message: string };
    try {
      await operationsByName.get_page!.handler(ctx(engine), { slug: asked });
      answer = { code: null, detail: null, message: 'read' };
    } catch (e) {
      answer = { code: (e as { code?: unknown }).code, detail: (e as { detail?: unknown }).detail, message: (e as Error).message };
    }
    expect(answer).toEqual({ code: 'invalid_params', detail: 'ambiguous_slug', message: AMBIGUOUS_REFUSAL(asked, nfd, nfc) });
    return answer;
  });
  parityTest('delete_page by the stored decomposed spelling soft-deletes that row in place, with no composed twin', { methods: ['putPage', 'readPageSnapshot'] }, async (engine, backend) => {
    const stored = 'notes/del-cafe\u0301';
    const composed = 'notes/del-caf\u00e9';
    if (backend === 'rust') await engine.putPage(stored, { type: 'note', title: 'Delete me', compiled_truth: 'Old.', timeline: '' });
    else {
      await engine.putPage(composed, { type: 'note', title: 'Delete me', compiled_truth: 'Old.', timeline: '' });
      await engine.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2', [stored, composed]);
    }
    const before = await engine.readPageSnapshot(stored, { sourceId: 'default', includeDeleted: true });
    let out: { slug: string; status: string; noop: boolean };
    try {
      out = await operationsByName.delete_page!.handler(ctx(engine), { slug: stored, expected_revision: before!.revision, request_id: randomUUID() }) as typeof out;
    } catch (e) {
      if (backend === 'rust') await expectRustDeleteRefusedBeforeWrite(engine, stored, before!.revision, e);
      throw e;
    }
    const after = await engine.readPageSnapshot(stored, { sourceId: 'default', includeDeleted: true });
    const twin = await engine.readPageSnapshot(composed, { sourceId: 'default', includeDeleted: true });
    const result = { slug: out.slug, status: out.status, noop: out.noop, deletedInPlace: after?.page.deleted_at != null, twin: twin?.page.slug ?? null };
    expect(result).toEqual({ slug: stored, status: 'soft_deleted', noop: false, deletedInPlace: true, twin: null });
    return result;
  });
  parityTest('restore_page by the stored decomposed spelling restores the row delete_page soft-deleted by it, with no composed twin', { methods: ['putPage', 'readPageSnapshot'] }, async (engine, backend) => {
    const stored = 'notes/res-cafe\u0301';
    const composed = 'notes/res-caf\u00e9';
    if (backend === 'rust') await engine.putPage(stored, { type: 'note', title: 'Restore me', compiled_truth: 'Old.', timeline: '' });
    else {
      await engine.putPage(composed, { type: 'note', title: 'Restore me', compiled_truth: 'Old.', timeline: '' });
      await engine.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2', [stored, composed]);
    }
    const revision = async () => (await engine.readPageSnapshot(stored, { sourceId: 'default', includeDeleted: true }))!.revision;
    const live = await revision();
    try {
      await operationsByName.delete_page!.handler(ctx(engine), { slug: stored, expected_revision: live, request_id: randomUUID() });
    } catch (e) {
      if (backend === 'rust') await expectRustDeleteRefusedBeforeWrite(engine, stored, live, e);
      throw e;
    }
    const out = await operationsByName.restore_page!.handler(ctx(engine), { slug: stored, expected_revision: await revision(), request_id: randomUUID() }) as { slug: string };
    const after = await engine.readPageSnapshot(stored, { sourceId: 'default', includeDeleted: true });
    const twin = await engine.readPageSnapshot(composed, { sourceId: 'default', includeDeleted: true });
    const result = { slug: out.slug, restoredInPlace: after !== null && after.page.deleted_at == null, twin: twin?.page.slug ?? null };
    expect(result).toEqual({ slug: stored, restoredInPlace: true, twin: null });
    return result;
  });
  parityTest('delete_page then restore_page by an ordinary slug bring the page back as it was, and Rust refuses the delete before it lands', { methods: ['putPage', 'readPageSnapshot'] }, async (engine, backend) => {
    const slug = 'notes/del-restore-plain';
    await engine.putPage(slug, { type: 'note', title: 'Plain', compiled_truth: 'Body.', timeline: '' });
    const revision = async () => (await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true }))!.revision;
    const live = await revision();
    let deleted: { slug: string; status: string; noop: boolean };
    try {
      deleted = await operationsByName.delete_page!.handler(ctx(engine), { slug, expected_revision: live, request_id: randomUUID() }) as typeof deleted;
    } catch (e) {
      if (backend === 'rust') await expectRustDeleteRefusedBeforeWrite(engine, slug, live, e);
      throw e;
    }
    const restored = await operationsByName.restore_page!.handler(ctx(engine), { slug, expected_revision: await revision(), request_id: randomUUID() }) as { slug: string; status: string };
    const page = await engine.readPageSnapshot(slug, { sourceId: 'default' });
    const result = { deleted: { slug: deleted.slug, status: deleted.status, noop: deleted.noop }, restored: { slug: restored.slug, status: restored.status },
      live: page !== null && page.page.deleted_at == null, body: page?.page.compiled_truth ?? null };
    expect(result).toEqual({ deleted: { slug, status: 'soft_deleted', noop: false }, restored: { slug, status: 'restored' }, live: true, body: 'Body.' });
    return result;
  });
  parityTest('a put by the exact spelling of a page stored with capitals is refused, and no lowercase twin is written', { methods: ['readPageSnapshot', 'listPages'] }, async (engine, backend) => {
    const stored = 'Notes/Seed-Cap';
    const lower = 'notes/seed-cap';
    if (backend === 'rust') {
      // A Rust put stores the slug lowercased; a shadow seed keeps a primary's stored spelling (seed/core.rs), so the case
      // stores the capital row the way a seed does.
      const store = await (engine as unknown as { storeFor(member: string): Promise<{ brain: { importRelation(...args: unknown[]): Promise<unknown> } }> }).storeFor('getPage');
      const now = new Date().toISOString();
      await store.brain.importRelation('seed-slug-normalize', 'pages', [{ id: '90001', source_id: 'default', slug: stored, type: 'note', title: 'Cap', compiled_truth: 'Old.',
        timeline: '', frontmatter: '{}', knowledge_revision: randomUUID(), created_at: now, updated_at: now }], null);
    } else {
      await engine.putPage(lower, { type: 'note', title: 'Cap', compiled_truth: 'Old.', timeline: '' });
      await engine.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2', [stored, lower]);
    }
    const pages = async () => (await engine.listPages({ includeDeleted: true })).map(p => ({ slug: p.slug, body: p.compiled_truth })).sort((a, b) => a.slug.localeCompare(b.slug));
    const before = await pages();
    let answer: { code: unknown; detail: unknown };
    try {
      await operationsByName.put_page!.handler(ctx(engine), { slug: stored, content: '---\ntype: note\ntitle: Cap\n---\nNew.\n', request_id: randomUUID() });
      answer = { code: null, detail: null };
    } catch (e) {
      if (backend === 'rust') {
        // The store cannot open the capital row by its exact spelling, so the admission read refuses before any write.
        expect({ code: (e as { code?: unknown }).code, message: (e as Error).message, pages: await pages() }).toEqual({ code: 'engine_capability_missing',
          message: "This brain's engine does not support readPageSnapshot (a page stored under a spelling with capitals) yet (it needs the pages capability), so nothing ran.", pages: before });
        throw e;
      }
      answer = { code: (e as { code?: unknown }).code, detail: (e as { detail?: unknown }).detail };
    }
    const result = { answer, before, after: await pages() };
    expect(result).toEqual({ answer: { code: 'invalid_params', detail: 'legacy_slug_spelling' }, before: [{ slug: stored, body: 'Old.' }], after: [{ slug: stored, body: 'Old.' }] });
    return result;
  });
  parityTest('ontology_propose and takes horizon set by a stored decomposed spelling act on that page, not on its composed look-alike', { methods: ['putPage', 'addTakesBatch'] }, async (engine, backend) => {
    const stored = 'people/look-zoe\u0308';
    const composed = 'people/look-zo\u00eb';
    try {
      await engine.putPage(composed, { type: 'person', title: 'Decomposed', compiled_truth: 'Old.', timeline: '' });
      await engine.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2', [stored, composed]);
      await engine.putPage(composed, { type: 'person', title: 'Composed', compiled_truth: 'Look-alike.', timeline: '' });
      const idOf = async (slug: string) => Number((await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1', [slug]))[0]!.id);
      const [storedId, composedId] = [await idOf(stored), await idOf(composed)];
      await engine.addTakesBatch([
        { page_id: storedId, row_num: 1, claim: 'Decomposed claim', kind: 'bet', holder: 'world', weight: 0.6, since_date: '2025-01-01' },
        { page_id: composedId, row_num: 1, claim: 'Composed claim', kind: 'bet', holder: 'world', weight: 0.6, since_date: '2025-01-01' },
      ]);
      await operationsByName.ontology_propose!.handler(ctx(engine), { entity: stored, dimension: 'role', value: 'advisor' });
      const quiet = console.log;
      console.log = () => {};
      try { await runTakes(engine, ['horizon', 'set', stored, '--row', '1', '--date', '2026-06-30']); } finally { console.log = quiet; }
      const facts = await engine.executeRaw<{ entity_slug: string }>('SELECT DISTINCT entity_slug FROM facts WHERE entity_slug IN ($1, $2)', [stored, composed]);
      const horizons = await engine.executeRaw<{ slug: string }>(
        `SELECT DISTINCT p.slug FROM take_horizons h JOIN takes t ON t.id = h.take_id JOIN pages p ON p.id = t.page_id WHERE p.slug IN ($1, $2)`, [stored, composed]);
      const result = { facts: facts.map(f => f.entity_slug), horizons: horizons.map(h => h.slug) };
      expect(result).toEqual({ facts: [stored], horizons: [stored] });
      return result;
    } catch (e) {
      if (backend === 'rust') { expect((e as Error).message).toBe(RUST_RAW_SQL_STOP); throw e; }
      throw e;
    }
  });
  parityTest('add_tag, remove_tag, add_timeline_entry, edit_page and append_page by the stored decomposed spelling change that row in place, with no composed twin', { methods: ['putPage', 'readPageSnapshot'] }, async (engine, backend) => {
    const stored = 'notes/write-cafe\u0301';
    const composed = 'notes/write-caf\u00e9';
    if (backend === 'rust') await engine.putPage(stored, { type: 'note', title: 'Write', compiled_truth: 'Body.', timeline: '' });
    else {
      await engine.putPage(composed, { type: 'note', title: 'Write', compiled_truth: 'Body.', timeline: '' });
      await engine.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2', [stored, composed]);
      await engine.executeRaw('UPDATE pages SET text_projection_revision = knowledge_revision WHERE slug = $1', [stored]);
    }
    const revision = async () => (await engine.readPageSnapshot(stored, { sourceId: 'default' }))!.revision;
    const outputs: Array<{ op: string; slug: unknown; status: unknown; noop: unknown }> = [];
    const run = async (op: string, params: Record<string, unknown>) => {
      try {
        const out = await operationsByName[op]!.handler(ctx(engine), { slug: stored, ...params }) as { slug?: unknown; status?: unknown; noop?: unknown };
        outputs.push({ op, slug: out.slug, status: out.status, noop: out.noop });
      } catch (e) {
        // On Rust every write before append_page lands; append_page stops in preparation at the inline-region read
        // (inlineRegions, src/core/page-body/tail-digest.ts), raw SQL the store does not serve, and nothing publishes.
        if (backend === 'rust') {
          expect({ op, code: (e as { code?: unknown }).code, message: (e as Error).message }).toEqual({ op: 'append_page', code: 'engine_capability_missing', message: RUST_JOURNAL_STOP });
          throw capabilityMissing('raw_sql', 'executeRaw');
        }
        throw e;
      }
    };
    await run('add_tag', { tag: 'added' });
    await run('add_tag', { tag: 'gone' });
    await run('remove_tag', { tag: 'gone' });
    await run('add_timeline_entry', { date: '2026-03-04', summary: 'added entry' });
    await run('edit_page', { expected_revision: await revision(), edits: [{ old_text: 'Body.', new_text: 'Changed.' }] });
    await run('append_page', { text: 'Appended.', request_id: randomUUID() });
    const rows = await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE slug LIKE $1 ORDER BY slug', ['notes/write-caf%']);
    const tags = await engine.executeRaw<{ tag: string }>('SELECT t.tag FROM tags t JOIN pages p ON p.id = t.page_id WHERE p.slug = $1 ORDER BY t.tag', [stored]);
    const timeline = await engine.executeRaw<{ summary: string }>('SELECT t.summary FROM timeline_entries t JOIN pages p ON p.id = t.page_id WHERE p.slug = $1', [stored]);
    const page = (await engine.readPageSnapshot(stored, { sourceId: 'default' }))!.page;
    const body = page.compiled_truth, whole = `${page.compiled_truth}\n${page.timeline}`;
    const result = { outputs, rows: rows.map(r => r.slug), tags: tags.map(t => t.tag), timeline: timeline.map(t => t.summary), changed: body.includes('Changed.'), appended: whole.includes('Appended.') };
    expect(result).toEqual({
      outputs: [
        { op: 'add_tag', slug: stored, status: 'ok', noop: false }, { op: 'add_tag', slug: stored, status: 'ok', noop: false }, { op: 'remove_tag', slug: stored, status: 'ok', noop: false },
        { op: 'add_timeline_entry', slug: stored, status: 'ok', noop: false }, { op: 'edit_page', slug: stored, status: 'created_or_updated', noop: false },
        { op: 'append_page', slug: stored, status: undefined, noop: undefined },
      ],
      rows: [stored], tags: ['added'], timeline: ['added entry'], changed: true, appended: true });
    return result;
  });
  parityTest('a capital spelling never answers its lowercase look-alike: get_page and the snapshot batch read the exact key (case-only collision)', { methods: ['readPageSnapshot', 'readPageSnapshotsBatch'] }, async (engine, backend) => {
    const stored = 'Notes/Case-Report';
    const lower = 'notes/case-report';
    if (backend === 'rust') {
      // A Rust put stores the slug lowercased; a seed keeps a primary's stored spelling (seed/core.rs), and a seed needs
      // an empty store, so the capital row goes in first.
      const store = await (engine as unknown as { storeFor(member: string): Promise<{ brain: { importRelation(...args: unknown[]): Promise<unknown> } }> }).storeFor('getPage');
      const now = new Date().toISOString();
      await store.brain.importRelation('seed-case-collision', 'pages', [{ id: '90021', source_id: 'default', slug: stored, type: 'note', title: 'Capital', compiled_truth: 'Capital.',
        timeline: '', frontmatter: '{}', knowledge_revision: randomUUID(), created_at: now, updated_at: now }], null);
    } else {
      await engine.putPage('notes/case-report-seed', { type: 'note', title: 'Capital', compiled_truth: 'Capital.', timeline: '' });
      await engine.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2', [stored, 'notes/case-report-seed']);
    }
    await engine.putPage(lower, { type: 'note', title: 'Lower', compiled_truth: 'Lower.', timeline: '' });
    await engine.putPage('notes/only-lower', { type: 'note', title: 'Only', compiled_truth: 'Only.', timeline: '' });
    // The batch reads each ref by its exact key: a capital spelling no page holds answers nothing, not the lowercase page.
    const batch = await engine.readPageSnapshotsBatch([{ slug: 'Notes/Only-Lower', sourceId: 'default' }, { slug: stored, sourceId: 'default' }]);
    const batchRead = [...batch.snapshots.values()].map(s => ({ slug: s.page.slug, body: s.page.compiled_truth }));
    const lowerRead = await operationsByName.get_page!.handler(ctx(engine), { slug: lower }) as { slug: string; compiled_truth: string };
    let capital: { slug: unknown; body: unknown };
    try {
      const page = await operationsByName.get_page!.handler(ctx(engine), { slug: stored }) as { slug: string; compiled_truth: string };
      capital = { slug: page.slug, body: page.compiled_truth };
    } catch (e) {
      if (backend === 'rust') {
        // The store reads the capital key exactly and refuses the page it holds there; the read never falls back to the
        // lowercase page.
        expect({ code: (e as { code?: unknown }).code, message: (e as Error).message, batchRead, lower: lowerRead.compiled_truth }).toEqual({ code: 'engine_capability_missing',
          message: "This brain's engine does not support getPage (a page stored under a spelling with capitals) yet (it needs the pages capability), so nothing ran.",
          batchRead: [{ slug: stored, body: 'Capital.' }], lower: 'Lower.' });
      }
      throw e;
    }
    const result = { batchRead, lower: { slug: lowerRead.slug, body: lowerRead.compiled_truth }, capital };
    expect(result).toEqual({ batchRead: [{ slug: stored, body: 'Capital.' }], lower: { slug: lower, body: 'Lower.' }, capital: { slug: stored, body: 'Capital.' } });
    return result;
  });

  parityTest('every write by the exact spelling of a capital-stored page changes that row in place, with no lowercase twin (the merge base answered page_not_found)', { methods: ['putPage', 'readPageSnapshot'] }, async (engine, backend) => {
    const stored = 'Notes/Write-Cap';
    const lower = 'notes/write-cap';
    if (backend === 'rust') {
      // The store keeps no capital spelling: a put lowercases the slug, and an exact read of the capital spelling answers
      // nothing, as PGLite answers a spelling it does not store. A capital-stored page cannot be set up, so the case stops.
      await engine.putPage(stored, { type: 'note', title: 'Cap', compiled_truth: 'Body.', timeline: '' });
      expect(await engine.readPageSnapshot(stored, { sourceId: 'default' })).toBeNull();
      expect((await engine.readPageSnapshot(lower, { sourceId: 'default' }))?.page.slug).toBe(lower);
      throw capabilityMissing('pages', 'putPage (a slug with capitals)', 'partial');
    } else {
      await engine.putPage(lower, { type: 'note', title: 'Cap', compiled_truth: 'Body.', timeline: '' });
      await engine.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2', [stored, lower]);
      await engine.executeRaw('UPDATE pages SET text_projection_revision = knowledge_revision WHERE slug = $1', [stored]);
    }
    const revision = async () => (await engine.readPageSnapshot(stored, { sourceId: 'default', includeDeleted: true }))!.revision;
    const outputs: Array<{ op: string; slug: unknown }> = [];
    const run = async (op: string, params: Record<string, unknown>) => {
      const out = await operationsByName[op]!.handler(ctx(engine), { slug: stored, ...params }) as { slug?: unknown };
      outputs.push({ op, slug: out.slug });
    };
    await run('add_tag', { tag: 'cap' });
    await run('add_timeline_entry', { date: '2026-03-04', summary: 'cap entry' });
    await run('edit_page', { expected_revision: await revision(), edits: [{ old_text: 'Body.', new_text: 'Changed.' }] });
    await run('append_page', { text: 'Appended.', request_id: randomUUID() });
    await run('delete_page', { expected_revision: await revision() });
    const rows = await engine.executeRaw<{ slug: string; deleted: boolean }>('SELECT slug, deleted_at IS NOT NULL AS deleted FROM pages WHERE lower(slug) = $1 ORDER BY slug', [lower]);
    const tags = await engine.executeRaw<{ tag: string }>('SELECT t.tag FROM tags t JOIN pages p ON p.id = t.page_id WHERE p.slug = $1', [stored]);
    const result = { outputs, rows, tags: tags.map(t => t.tag) };
    expect(result).toEqual({
      outputs: ['add_tag', 'add_timeline_entry', 'edit_page', 'append_page', 'delete_page'].map(op => ({ op, slug: stored })),
      rows: [{ slug: stored, deleted: true }], tags: ['cap'] });
    return result;
  });

  parityTest('a put by the stored decomposed spelling is refused even when its composed twin exists, and neither page changes', { methods: ['putPage', 'readPageSnapshot'] }, async (engine, backend) => {
    const stored = 'notes/twin-cafe\u0301';
    const composed = 'notes/twin-caf\u00e9';
    if (backend === 'rust') {
      await engine.putPage(stored, { type: 'note', title: 'Legacy', compiled_truth: 'Old.', timeline: '' });
      await engine.putPage(composed, { type: 'note', title: 'Twin', compiled_truth: 'Twin.', timeline: '' });
    } else {
      await engine.putPage(composed, { type: 'note', title: 'Legacy', compiled_truth: 'Old.', timeline: '' });
      await engine.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2', [stored, composed]);
      await engine.putPage(composed, { type: 'note', title: 'Twin', compiled_truth: 'Twin.', timeline: '' });
    }
    const read = async (slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true }))!;
    const before = { stored: (await read(stored)).revision, composed: (await read(composed)).revision };
    let answer: { code: unknown; detail: unknown; message: string };
    try {
      await operationsByName.put_page!.handler(ctx(engine), { slug: stored, content: '---\ntype: note\ntitle: Legacy\n---\nNew.\n', request_id: randomUUID() });
      answer = { code: null, detail: null, message: 'written' };
    } catch (e) {
      answer = { code: (e as { code?: unknown }).code, detail: (e as { detail?: unknown }).detail, message: (e as Error).message };
    }
    const result = { answer, unchanged: (await read(stored)).revision === before.stored && (await read(composed)).revision === before.composed };
    expect(result).toEqual({ answer: { code: 'invalid_params', detail: 'legacy_slug_spelling', message: LEGACY_REFUSAL(stored, composed) }, unchanged: true });
    return result;
  });
  parityTest('a stored spelling that normalizeSlug maps to the asked slug answers it, including a capital that lowercases to two characters', { methods: ['putPage', 'getPage'] }, async (engine, backend) => {
    const stored = 'Unicode/CAF\u00c9-\u0130';
    try {
      await engine.putPage('unicode/seed', { type: 'note', title: 'Expansion', compiled_truth: 'Body.', timeline: '' });
      await engine.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2', [stored, 'unicode/seed']);
    } catch (e) {
      if (backend === 'rust') expect((e as Error).message).toBe(RUST_RAW_SQL_STOP);
      throw e;
    }
    const page = await operationsByName.get_page!.handler(ctx(engine), { slug: 'unicode/cafe\u0301-i\u0307' }) as { slug: string; title: string };
    expect({ slug: page.slug, title: page.title }).toEqual({ slug: stored, title: 'Expansion' });
    return { slug: page.slug, title: page.title };
  });
  parityTest('rows of another source never use up the candidates the readable source holds: two readable spellings are ambiguous, byte for byte', { methods: ['putPage', 'getPage'] }, async (engine, backend) => {
    const spell = (bits: number) => 'f7/' + [...'abcdefgh'].map((c, i) => (bits >> i) & 1 ? c.toUpperCase() : c).join('');
    const put = async (slug: string, sourceId: string) => {
      await engine.putPage('f7/seed', { type: 'note', title: slug, compiled_truth: 'Body.', timeline: '' }, { sourceId });
      await engine.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2 AND source_id = $3', [slug, 'f7/seed', sourceId]);
    };
    try {
      await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('beta', 'beta') ON CONFLICT DO NOTHING`);
      for (let bits = 1; bits <= 24; bits++) await put(spell(bits), 'beta');
      await put(spell(128), 'default');
      await put(spell(255), 'default');
    } catch (e) {
      if (backend === 'rust') expect((e as Error).message).toBe(RUST_RAW_SQL_STOP);
      throw e;
    }
    let answer: { code: unknown; detail: unknown; named: boolean };
    try {
      await operationsByName.get_page!.handler(ctx(engine), { slug: 'F7/ABCDEFGH' });
      answer = { code: null, detail: null, named: false };
    } catch (e) {
      const message = (e as Error).message;
      answer = { code: (e as { code?: unknown }).code, detail: (e as { detail?: unknown }).detail, named: message.includes(JSON.stringify(spell(255))) && message.includes(JSON.stringify(spell(128))) };
    }
    expect(answer).toEqual({ code: 'invalid_params', detail: 'ambiguous_slug', named: true });
    return answer;
  });
});
