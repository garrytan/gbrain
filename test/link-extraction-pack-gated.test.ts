// v0.42.53.0 — pack-gated body-verb inference.
//
// `inferLinkType` emits verbs (founded / invested_in / advises / works_at)
// from hardcoded prose regexes WITHOUT consulting the active schema pack.
// Before this change, a brain whose active pack did NOT declare a verb (e.g.
// a pack with no `invested_in` in its `link_types`) still got `invested_in`
// edges whenever the regex misfired on prose. These tests pin the gate:
//   (a) a pack WITHOUT `invested_in` suppresses a regex-inferred invested_in
//       → mentions;
//   (b) a pack WITH `invested_in` keeps it;
//   (c) the no-pack path (allowlist undefined) is unchanged;
//   (d) the default gbrain-base pack declares all four verbs, so default
//       installs are unaffected.
//
// Privacy: fixtures use only generic placeholders (widget-co, a-founder).

import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import {
  extractPageLinks,
  gateInferredVerb,
  inferLinkType,
} from '../src/core/link-extraction.ts';
import { loadPackFromFile } from '../src/core/schema-pack/loader.ts';

// Resolver that resolves any "<dir>/<slug>" shape to itself (pretend every page
// exists). Mirrors test/link-extraction.test.ts's allowAllResolver.
const allowAllResolver = {
  resolve: async (name: string) => {
    if (/^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(name)) return name;
    return null;
  },
};

// Prose that the production INVESTED_RE matches → inferLinkType returns
// 'invested_in' for the company ref. Uses generic placeholders only.
const INVEST_CONTENT =
  '[Widget Co](companies/widget-co) is a portfolio company — we invested in the seed round.';

describe('gateInferredVerb (unit)', () => {
  test('no allowlist (undefined) is a pure no-op — every verb passes through', () => {
    expect(gateInferredVerb('invested_in', undefined)).toBe('invested_in');
    expect(gateInferredVerb('founded', undefined)).toBe('founded');
    expect(gateInferredVerb('mentions', undefined)).toBe('mentions');
  });

  test('a declared gateable verb survives', () => {
    const pack = new Set(['invested_in', 'mentions']);
    expect(gateInferredVerb('invested_in', pack)).toBe('invested_in');
  });

  test('an undeclared gateable verb degrades to mentions', () => {
    const pack = new Set(['mentions', 'works_at']);
    expect(gateInferredVerb('invested_in', pack)).toBe('mentions');
    expect(gateInferredVerb('founded', pack)).toBe('mentions');
    expect(gateInferredVerb('advises', pack)).toBe('mentions');
  });

  test('structural verbs are NEVER gated even when absent from the allowlist', () => {
    // A pack with an empty link_types set must NOT lose attended/image_of/
    // mentions — those are page-type-deterministic, not prose guesses.
    const empty = new Set<string>();
    expect(gateInferredVerb('mentions', empty)).toBe('mentions');
    expect(gateInferredVerb('attended', empty)).toBe('attended');
    expect(gateInferredVerb('image_of', empty)).toBe('image_of');
  });
});

describe('extractPageLinks — pack-gated body inference', () => {
  // Sanity: the fixture really does trip the legacy invested_in inference.
  test('precondition: inferLinkType regex-infers invested_in on the fixture', () => {
    const verb = inferLinkType('person', INVEST_CONTENT, INVEST_CONTENT, 'companies/widget-co');
    expect(verb).toBe('invested_in');
  });

  test('(a) pack WITHOUT invested_in suppresses the regex-inferred edge → mentions', async () => {
    const allowlist = new Set(['mentions', 'works_at', 'founded']); // no invested_in
    const { candidates } = await extractPageLinks(
      'people/a-founder', INVEST_CONTENT, {}, 'person', allowAllResolver,
      { inferredVerbAllowlist: allowlist },
    );
    const edge = candidates.find(c => c.targetSlug === 'companies/widget-co');
    expect(edge).toBeDefined();
    expect(edge!.linkType).toBe('mentions');
  });

  test('(b) pack WITH invested_in keeps the regex-inferred edge', async () => {
    const allowlist = new Set(['mentions', 'invested_in']);
    const { candidates } = await extractPageLinks(
      'people/a-founder', INVEST_CONTENT, {}, 'person', allowAllResolver,
      { inferredVerbAllowlist: allowlist },
    );
    const edge = candidates.find(c => c.targetSlug === 'companies/widget-co');
    expect(edge).toBeDefined();
    expect(edge!.linkType).toBe('invested_in');
  });

  test('(c) no-pack path (no allowlist) is unchanged — verb still emitted', async () => {
    const { candidates } = await extractPageLinks(
      'people/a-founder', INVEST_CONTENT, {}, 'person', allowAllResolver,
      // no inferredVerbAllowlist
    );
    const edge = candidates.find(c => c.targetSlug === 'companies/widget-co');
    expect(edge).toBeDefined();
    expect(edge!.linkType).toBe('invested_in');
  });

  test('bare-slug body refs are gated too (second call site)', async () => {
    const bare = 'See companies/widget-co — we invested in the seed round.';
    const allowlist = new Set(['mentions']); // no invested_in
    const { candidates } = await extractPageLinks(
      'people/a-founder', bare, {}, 'person', allowAllResolver,
      { inferredVerbAllowlist: allowlist },
    );
    const edge = candidates.find(c => c.targetSlug === 'companies/widget-co');
    expect(edge).toBeDefined();
    expect(edge!.linkType).toBe('mentions');
  });
});

describe('(d) gbrain-base default pack is unaffected', () => {
  // Load the real bundled gbrain-base manifest through the production loader
  // and confirm its link_types declares every gateable verb — so a default
  // install keeps all four.
  const manifest = loadPackFromFile(
    join(import.meta.dir, '..', 'src', 'core', 'schema-pack', 'base', 'gbrain-base.yaml'),
  );
  const baseLinkTypes = new Set(manifest.link_types.map(lt => lt.name));

  test('gbrain-base declares all four gateable verbs', () => {
    for (const verb of ['founded', 'invested_in', 'advises', 'works_at']) {
      expect(baseLinkTypes.has(verb)).toBe(true);
    }
  });

  test('gating against gbrain-base keeps the regex-inferred verb', async () => {
    const { candidates } = await extractPageLinks(
      'people/a-founder', INVEST_CONTENT, {}, 'person', allowAllResolver,
      { inferredVerbAllowlist: baseLinkTypes },
    );
    const edge = candidates.find(c => c.targetSlug === 'companies/widget-co');
    expect(edge).toBeDefined();
    expect(edge!.linkType).toBe('invested_in');
  });
});
