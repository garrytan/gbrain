/**
 * #4655 write-time pack vocabulary helpers — the edges the capture / add_link
 * negative-regression tests do not reach:
 *   - loader: a rejecting engine.getConfig never throws (resolution falls
 *     through to the env / file tiers); an unresolvable pack name → null, so
 *     the write proceeds (enforcement only where a vocabulary exists).
 *   - previewNames bound (via the suggestion builders): 0 names →
 *     'none declared'; 15 names → the first 12 plus a '(15 total)' tail.
 *   - add_link dry-run previews the rejection — the vocabulary check runs
 *     BEFORE the dry-run return, and a declared / omitted verb still previews.
 */

import { describe, expect, test } from 'bun:test';
import {
  loadActivePackForWriteVocabulary,
  packDeclaresLinkType,
  packDeclaresPageType,
  undeclaredLinkTypeSuggestion,
  undeclaredPageTypeSuggestion,
} from '../src/core/schema-pack/write-vocabulary.ts';
import type { ResolvedPack } from '../src/core/schema-pack/registry.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

function fakePack(pageTypes: string[], linkTypes: string[] = []): ResolvedPack {
  return {
    manifest: {
      name: 'fake-pack',
      page_types: pageTypes.map((name) => ({ name })),
      link_types: linkTypes.map((name) => ({ name })),
    },
    identity: 'fake-pack@0.0.0+00000000',
    manifest_sha8: '00000000',
    alias_closure_hash: '0',
    alias_graph: {},
  } as unknown as ResolvedPack;
}

describe('loadActivePackForWriteVocabulary (best-effort loader)', () => {
  test('a rejecting engine.getConfig never throws — resolution falls through to the env tier', async () => {
    const engine = { getConfig: async () => { throw new Error('connection lost'); } };
    await withEnv({ GBRAIN_SCHEMA_PACK: 'gbrain-base' }, async () => {
      const pack = await loadActivePackForWriteVocabulary({ engine, remote: true });
      expect(pack).not.toBeNull();
      expect(pack!.manifest.name).toBe('gbrain-base');
    });
  });

  test('an unresolvable pack name → null (no vocabulary to enforce; the write proceeds)', async () => {
    const engine = { getConfig: async () => 'definitely-not-a-real-pack-name' };
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const pack = await loadActivePackForWriteVocabulary({ engine, remote: true });
      expect(pack).toBeNull();
    });
  });

  test('env-tier garbage → null too (loader is never a new way for writes to fail)', async () => {
    const engine = { getConfig: async () => null };
    await withEnv({ GBRAIN_SCHEMA_PACK: 'nope-not-a-pack' }, async () => {
      expect(await loadActivePackForWriteVocabulary({ engine, remote: false })).toBeNull();
    });
  });
});

describe('membership helpers', () => {
  test('packDeclaresPageType / packDeclaresLinkType are exact-name checks', () => {
    const pack = fakePack(['note', 'meeting'], ['works_at']);
    expect(packDeclaresPageType(pack, 'meeting')).toBe(true);
    expect(packDeclaresPageType(pack, 'Meeting')).toBe(false);
    expect(packDeclaresPageType(pack, 'works_at')).toBe(false);
    expect(packDeclaresLinkType(pack, 'works_at')).toBe(true);
    expect(packDeclaresLinkType(pack, 'note')).toBe(false);
  });
});

describe('previewNames bound (via the suggestion builders)', () => {
  test('0 declared names → "(none declared)"', () => {
    expect(undeclaredPageTypeSuggestion(fakePack([]))).toContain('(none declared)');
    expect(undeclaredLinkTypeSuggestion(fakePack([]))).toContain('(none declared)');
  });

  test('15 names → the first 12 (sorted) plus a "(15 total)" tail', () => {
    const names = Array.from({ length: 15 }, (_, i) => `type-${String(i).padStart(2, '0')}`);
    // Declared in reverse to prove the preview sorts before slicing.
    const s = undeclaredPageTypeSuggestion(fakePack([...names].reverse()));
    for (const n of names.slice(0, 12)) expect(s).toContain(n);
    for (const n of names.slice(12)) expect(s).not.toContain(n);
    expect(s).toContain('(15 total)');
  });

  test('12 or fewer names → every name shown, no total suffix', () => {
    const s = undeclaredLinkTypeSuggestion(fakePack([], ['b_verb', 'a_verb']));
    expect(s).toContain('(a_verb, b_verb)');
    expect(s).not.toContain('total');
  });
});

describe('add_link dry-run previews the vocabulary rejection', () => {
  const addLink = operations.find((o) => o.name === 'add_link')!;

  function ctx(): OperationContext {
    // dry_run short-circuits before any real engine call; only getConfig
    // (the pack pin) is consulted.
    const engine = { getConfig: async () => 'gbrain-base' } as unknown as BrainEngine;
    return {
      engine,
      config: { engine: 'pglite' } as any,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: true,
      remote: true,
      sourceId: 'default',
    };
  }

  test('an undeclared explicit link_type is rejected BEFORE the dry-run return', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      await expect(
        addLink.handler(ctx(), { from: 'people/alice-example', to: 'orgs/acme-example', link_type: 'definitely_not_a_link_verb' }),
      ).rejects.toThrow(/link type 'definitely_not_a_link_verb' is not declared in active schema pack 'gbrain-base'/);
    });
  });

  test('a declared link_type still reaches the dry-run preview', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const pack = await loadActivePackForWriteVocabulary({ engine: ctx().engine, remote: true });
      const declared = pack!.manifest.link_types[0]!.name;
      const result = await addLink.handler(ctx(), { from: 'people/alice-example', to: 'orgs/acme-example', link_type: declared });
      expect(result).toMatchObject({ dry_run: true, action: 'add_link' });
    });
  });

  test('an omitted link_type is the untyped-edge default — never vocabulary-checked', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const result = await addLink.handler(ctx(), { from: 'people/alice-example', to: 'orgs/acme-example' });
      expect(result).toMatchObject({ dry_run: true, action: 'add_link' });
    });
  });
});
