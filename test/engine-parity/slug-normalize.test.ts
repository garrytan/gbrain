/**
 * BrainEngine parity — slugs in one normal form: lowercase, then Unicode NFC (normalizeSlug, src/core/utils.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 *    GBRAIN_TEST_RUST_ARM=1), `putPage` stores a decomposed (NFD) slug in NFC, get_page answers a capitalised
 *    or decomposed spelling of a stored slug with that page, and the shared link extractor turns an NFD
 *    wikilink into the NFC slug the engine stored. A put_page by the exact decomposed spelling a page is still
 *    stored under is refused with the same text (detail legacy_slug_spelling); nothing moves and no twin appears.
 *  - Regression: an engine that keeps the caller's NFD bytes (two pages that print the same name), or an op
 *    path that looks the raw spelling up and answers page_not_found for `People/Alice-Example`.
 *  - Why existing coverage misses it: every parity case writes and reads lowercase NFC slugs.
 *  - Seam: none. Real engines; get_page runs through the registry operation.
 *
 * Rust arm known stops (each case asserts the exact Rust answer, then rethrows or throws the typed refusal):
 *  - get_page: member `readPageSnapshot`, option `resolveAlias` (Rust pages area, store-members/pages.ts):
 *    the Rust store does not serve resolveAlias on master yet, so the op refuses before any slug is read.
 *  - NFC storage: member `putPage` (Rust pages area, gbrain-store pages.rs `validate_slug`): the Rust store
 *    lowercases a slug but does not compose it to NFC, so an NFD slug is stored as NFD and the NFC read
 *    misses it. Rust must compose to NFC in `validate_slug` and in its lowercased read lookups.
 *  - legacy-spelling put refusal: member `readPersistenceBrainId`, capability `persistence_journal` (Rust
 *    persistence area): put_page needs the write journal, which the Rust store does not serve, so the op stops
 *    before admission. When it does, Rust must answer the same refusal text (it is built in TS admission from
 *    readPageSnapshot of the lowercased spelling).
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { extractPageLinks } from '../../src/core/link-extraction.ts';
import { capabilityMissing } from '../../src/core/rust-engine/errors.ts';
import { randomUUID } from 'node:crypto';

const { parityTest } = parityArms(testBackends());

const NFC_CAFE = 'notes/café';
const NFC_ZOE = 'people/zoë-example';
const NFD_ZOE = 'people/zoë-example';
const LEGACY_REFUSAL = (stored: string, composed: string) => `Page ${stored} is stored under an older decomposed Unicode spelling of its name, so a put by that spelling is refused and nothing was changed. `
  + `A fix that moves the page to the composed spelling ${composed} is coming; until then the page cannot be replaced by put.`;
const RUST_JOURNAL_STOP =
  "This brain's engine does not support readPersistenceBrainId yet (it needs the persistence_journal capability), so nothing ran.";
const RUST_RESOLVE_ALIAS_STOP =
  "This brain's engine does not support readPageSnapshot (option resolveAlias) yet (it needs the pages capability), so nothing ran.";

function ctx(engine: BrainEngine): OperationContext {
  return { engine, config: { engine: engine.kind, embedding_disabled: true } as never, remote: false, sourceId: 'default',
    dryRun: false, logger: { info() {}, warn() {}, error() {} } } as OperationContext;
}

describe('engine parity: slug normal form', () => {
  parityTest('get_page reads a capitalised or decomposed spelling of the stored slug', { methods: ['putPage', 'readPageSnapshot'] }, async (engine, backend) => {
    await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Alice.', timeline: '' });
    await engine.putPage(NFC_CAFE, { type: 'note', title: 'Cafe', compiled_truth: 'Coffee.', timeline: '' });
    const reads = [];
    for (const asked of ['People/Alice-Example', 'notes/café', 'NOTES/CAFÉ']) {
      try {
        const page = await operationsByName.get_page!.handler(ctx(engine), { slug: asked }) as { slug: string; title: string };
        reads.push({ asked, slug: page.slug, title: page.title });
      } catch (e) {
        if (backend === 'rust') expect((e as Error).message).toBe(RUST_RESOLVE_ALIAS_STOP);
        throw e;
      }
    }
    expect(reads.map(r => r.slug)).toEqual(['people/alice-example', NFC_CAFE, NFC_CAFE]);
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
        if (backend === 'rust') { expect((e as Error).message).toBe(RUST_JOURNAL_STOP); throw e; }
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
});
