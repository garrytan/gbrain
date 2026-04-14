import { describe, test, expect } from 'bun:test';
import { operations } from '../src/core/operations.ts';

// These tests verify the readonly mode contract without starting
// a full MCP server. They test the data layer (operation flags) and
// the filtering logic that the server uses.

describe('MCP readonly mode — operation flags', () => {
  const mutating = operations.filter(op => op.mutating);
  const readonly = operations.filter(op => !op.mutating);

  test('mutating operations are correctly flagged', () => {
    const mutatingNames = mutating.map(op => op.name).sort();
    expect(mutatingNames).toEqual([
      'add_link',
      'add_tag',
      'add_timeline_entry',
      'delete_page',
      'file_upload',
      'log_ingest',
      'put_page',
      'put_raw_data',
      'remove_link',
      'remove_tag',
      'revert_version',
      'sync_brain',
    ]);
  });

  test('read-only operations are NOT flagged as mutating', () => {
    const readonlyNames = readonly.map(op => op.name).sort();
    expect(readonlyNames).toContain('get_page');
    expect(readonlyNames).toContain('search');
    expect(readonlyNames).toContain('query');
    expect(readonlyNames).toContain('list_pages');
    expect(readonlyNames).toContain('get_health');
    expect(readonlyNames).toContain('file_list');
    expect(readonlyNames).toContain('file_url');
    // None of the read-only ops should have mutating set
    for (const op of readonly) {
      expect(op.mutating).toBeFalsy();
    }
  });

  test('every operation has an explicit mutating decision', () => {
    // If a new operation is added without thinking about mutating,
    // it defaults to undefined (falsy = readonly). This test makes
    // sure the total count is what we expect so a new op without
    // the flag triggers a review.
    expect(operations.length).toBe(30);
    expect(mutating.length).toBe(12);
    expect(readonly.length).toBe(18);
  });
});

describe('MCP readonly mode — filtering logic', () => {
  test('readonly mode filters out mutating operations', () => {
    const readonly = true;
    const visible = readonly
      ? operations.filter(op => !op.mutating)
      : operations;

    expect(visible.length).toBe(18);
    expect(visible.find(op => op.name === 'get_page')).toBeTruthy();
    expect(visible.find(op => op.name === 'search')).toBeTruthy();
    expect(visible.find(op => op.name === 'delete_page')).toBeUndefined();
    expect(visible.find(op => op.name === 'put_page')).toBeUndefined();
    expect(visible.find(op => op.name === 'file_upload')).toBeUndefined();
  });

  test('non-readonly mode exposes all operations', () => {
    const readonly = false;
    const visible = readonly
      ? operations.filter(op => !op.mutating)
      : operations;

    expect(visible.length).toBe(30);
    expect(visible.find(op => op.name === 'delete_page')).toBeTruthy();
    expect(visible.find(op => op.name === 'put_page')).toBeTruthy();
  });

  test('mutating check rejects in readonly mode', () => {
    const readonly = true;
    const op = operations.find(o => o.name === 'delete_page')!;
    const blocked = readonly && op.mutating;
    expect(blocked).toBe(true);
  });

  test('mutating check allows in non-readonly mode', () => {
    const readonly = false;
    const op = operations.find(o => o.name === 'delete_page')!;
    const blocked = readonly && op.mutating;
    expect(blocked).toBe(false);
  });

  test('read-only ops pass in both modes', () => {
    const op = operations.find(o => o.name === 'search')!;
    expect(true && op.mutating).toBeFalsy();  // readonly=true
    expect(false && op.mutating).toBeFalsy(); // readonly=false
  });
});
