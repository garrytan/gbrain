import { expect, test } from 'bun:test';
import { mergeReconcile, reconcileDecisions } from '../src/core/persistence/reconcile-merge.ts';
import type { ParsedPage } from '../src/core/import-file.ts';

const page = (frontmatter: Record<string, unknown> = {}): ParsedPage => ({ type: 'note', title: 'Example',
  compiled_truth: 'A useful example observation.', timeline: '', frontmatter, tags: [] });

test('preserves unknown nested one-sided fields and add-only tags', () => {
  const file = { ...page({ profile: { location: 'example-place' }, custom_file: [1, 2] }), tags: ['file-tag'] };
  const database = { ...page({ profile: { role: 'example-role' }, custom_database: null }), tags: ['database-tag'] };
  expect(mergeReconcile(file, database)).toMatchObject({ conflicts: [], result: {
    frontmatter: { profile: { location: 'example-place', role: 'example-role' }, custom_file: [1, 2], custom_database: null },
    tags: ['database-tag', 'file-tag'] } });
});

test('requires exact escaped pointer decisions for scalar, type and array conflicts', () => {
  const file = page({ 'a/b': { '~key': 1 }, list: ['file'], mixed: {} });
  const database = page({ 'a/b': { '~key': 2 }, list: ['database'], mixed: 'scalar' });
  const before = mergeReconcile(file, database);
  expect(before.conflicts.map(c => c.path)).toEqual(['/frontmatter/a~1b/~0key', '/frontmatter/list', '/frontmatter/mixed']);
  const resolved = mergeReconcile(file, database, [
    { path: '/frontmatter/a~1b/~0key', action: 'take_file' },
    { path: '/frontmatter/list', action: 'set_value', value: ['explicit'] },
    { path: '/frontmatter/mixed', action: 'delete' },
  ]);
  expect(resolved.conflicts).toEqual([]);
  expect(resolved.result.frontmatter).toEqual({ 'a/b': { '~key': 1 }, list: ['explicit'] });
});

test('deletion is explicit even for one-sided metadata and no timestamps win', () => {
  const file = page({ obsolete: true, updated_at: '2030-01-01' });
  const database = page({ updated_at: '2020-01-01' });
  expect(mergeReconcile(file, database).conflicts).toHaveLength(1);
  expect(mergeReconcile(file, database).result.frontmatter.obsolete).toBe(true);
  expect(mergeReconcile(file, database, [{ path: '/frontmatter/obsolete', action: 'delete' }]).result.frontmatter.obsolete).toBeUndefined();
});

test('preserves trusted metadata, classifies exact scan keys and rejects protected decisions', () => {
  const file = page({ visibility: 'world', source_hash: 'forged', atoms_scan_hash: 'old', atoms_custom: 'keep', quarantine: false });
  const database = page({ visibility: 'private', source_hash: 'trusted', quarantine: { reason: 'junk_pattern' } });
  const merged = mergeReconcile(file, database);
  expect(merged.result.frontmatter).toEqual({ visibility: 'private', source_hash: 'trusted', atoms_custom: 'keep', quarantine: { reason: 'junk_pattern' } });
  expect(merged.scanPaths).toEqual(['/frontmatter/atoms_scan_hash']);
  expect(() => mergeReconcile(file, database, [{ path: '/frontmatter/visibility', action: 'take_file' }])).toThrow('protected');
  expect(() => reconcileDecisions([{ path: '/frontmatter', action: 'set_value', value: {} }])).toThrow('protected');
});

test('unknown metadata with sensitive-looking prefixes is preserved without granting trusted provenance', () => {
  const fields = { source_custom_label: 'keep', provenance_notes: { ordinary: true }, withdrawal_notes: 'keep', safety_review: 'keep',
    permission_context: 'keep', trust_custom: 'keep', ingested_custom: 'keep', atoms_scan_custom: 'keep' };
  const merged = mergeReconcile(page({ ...fields, source_quote_offset: [1, 2] }), page());
  expect(merged.result.frontmatter).toEqual(fields);
  expect(merged.protectedPaths).toEqual(['/frontmatter/source_quote_offset']);
  expect(mergeReconcile(page({ status: 'ordinary-status' }), page()).result.frontmatter.status).toBe('ordinary-status');
  expect(mergeReconcile(page({ status: 'verified' }), page({ provenance: 'auto-extracted', status: 'unverified' })).result.frontmatter.status).toBe('unverified');
});

test('rejects unknown, duplicate, overlapping and malformed decisions', () => {
  expect(() => mergeReconcile(page(), page(), [{ path: '/frontmatter/missing', action: 'delete' }])).toThrow('unknown');
  expect(() => reconcileDecisions([{ path: '/frontmatter/x', action: 'delete' }, { path: '/frontmatter/x/y', action: 'delete' }])).toThrow('overlapping');
  expect(() => reconcileDecisions([{ path: '/bad~2path', action: 'delete' }])).toThrow('Pointer');
  expect(() => reconcileDecisions([{ path: '/frontmatter/x', action: 'delete', value: true }])).toThrow('Invalid');
  expect(() => reconcileDecisions([{ path: '/tags', action: 'set_value', value: [] }])).toThrow('protected');
});
