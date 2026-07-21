// #2117 — gbrain-base-v2 shipped with no `phases:` declaration and zero
// link_types[].inference regexes, so extract_atoms was silently pack-gated
// off and extract-ner returned pack_unavailable on the bundled default pack.
// These assertions fail against the pre-fix yaml.

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { loadPackFromFile } from '../src/core/schema-pack/loader.ts';
import { linkTypesUndeclared } from '../src/core/schema-pack/lint-rules.ts';

const V2_PATH = join(import.meta.dir, '..', 'src', 'core', 'schema-pack', 'base', 'gbrain-base-v2.yaml');

describe('gbrain-base-v2 capability parity (#2117)', () => {
  const manifest = loadPackFromFile(V2_PATH);

  it('declares the extract_atoms cycle phase', () => {
    expect(manifest.phases ?? []).toContain('extract_atoms');
  });

  it('ships at least one link_type inference regex so extract-ner is not pack_unavailable', () => {
    // Mirrors the extract-ner hasRegex predicate exactly.
    const hasRegex = manifest.link_types.some(
      (lt) => lt.inference && typeof lt.inference === 'object' && 'regex' in lt.inference,
    );
    expect(hasRegex).toBe(true);
  });

  it('ports the v1 inference verbs it declares link types for', () => {
    const withRegex = manifest.link_types
      .filter((lt) => lt.inference?.regex)
      .map((lt) => lt.name)
      .sort();
    expect(withRegex).toEqual(['founded', 'invested_in', 'works_at']);
  });

  it('inference rules pass the undeclared-page-type lint (no meeting-bound inference)', async () => {
    const issues = await linkTypesUndeclared(manifest);
    expect(issues).toEqual([]);
  });
});
