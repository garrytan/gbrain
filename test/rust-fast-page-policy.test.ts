/**
 * The store policy for the chat census's fast page filter (rust-engine/store-members/private-provenance.ts
 * `storeFastPageTextPolicy`) is served only for the canonical text.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a caller with no record, or a record of no readers, gets a policy; a record that adds folder coverage
 *    refuses with engine_capability_missing, so the store never counts a page the SQL text hides. A private-readable grant
 *    is read by neither the SQL text nor the store policy, so it is served.
 *  - Regression: a policy built from the page policy alone would drop the folder-coverage conjunct of the fast filter and
 *    count pages under a pending prefix.
 *  - Why existing coverage misses it: the parity case runs with no caller record.
 *  - Seam: none; pure text rendering.
 */
import { describe, expect, test } from 'bun:test';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';
import { storeFastPageTextPolicy } from '../src/core/rust-engine/store-members/private-provenance.ts';

describe('storeFastPageTextPolicy', () => {
  test('serves the caller with no record and the record of no readers', () => {
    expect(storeFastPageTextPolicy('listChatChannelCensus').honorAliases).toBe(true);
    withCallerAccess({ identity: [], privateReadableSources: [], hidePrivate: true }, () => {
      expect(storeFastPageTextPolicy('listChatChannelCensus').ownerOnly).toBeDefined();
    });
  });

  test('refuses a record that adds folder coverage the store policy does not carry', () => {
    const refusal = (): unknown => {
      try {
        withCallerAccess({ identity: [], privateReadableSources: [], hidePrivate: true, folderCoverage: [{ source_id: 'default', prefix: 'hr/' }] }, () =>
          storeFastPageTextPolicy('listChatChannelCensus'));
      } catch (e) { return (e as { code?: string }).code; }
      return 'served';
    };
    expect(refusal()).toBe('engine_capability_missing');
  });

  test('a private-readable grant changes nothing: the fast filter reads the no-caller page policy', () => {
    withCallerAccess({ identity: [], privateReadableSources: ['default'], hidePrivate: true }, () => {
      expect(storeFastPageTextPolicy('listChatChannelCensus').identity).toEqual([]);
    });
  });
});
