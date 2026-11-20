/**
 * BrainEngine parity — slugs in one normal form: lowercase, then Unicode NFC (normalizeSlug, src/core/utils.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 *    GBRAIN_TEST_RUST_ARM=1), `putPage` stores a decomposed (NFD) slug in NFC, get_page answers a capitalised
 *    or decomposed spelling of a stored slug with that page, and the shared link extractor turns an NFD
 *    wikilink into the NFC slug the engine stored.
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
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { extractPageLinks } from '../../src/core/link-extraction.ts';
import { capabilityMissing } from '../../src/core/rust-engine/errors.ts';

const { parityTest } = parityArms(testBackends());

const NFC_CAFE = 'notes/café';
const NFC_ZOE = 'people/zoë-example';
const NFD_ZOE = 'people/zoë-example';
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
});
