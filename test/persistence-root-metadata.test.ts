import { describe, expect, test } from 'bun:test';
import { isPhysicalRootMetadata, withoutPhysicalRootMetadata } from '../src/core/persistence/root-metadata.ts';

describe('withoutPhysicalRootMetadata', () => {
  const reservation = `.gbrain-owner-${'a'.repeat(64)}.json`;

  test('drops the ownership stamp and reservation entries at any depth', () => {
    expect(withoutPhysicalRootMetadata(`?? .gbrain-owner.json\n?? brain/.gbrain-owner.json\n?? ${reservation}\n`)).toBe('');
  });

  test('keeps real changes next to the stamp', () => {
    expect(withoutPhysicalRootMetadata(' M notes/a.md\n?? .gbrain-owner.json\n?? b.md\n')).toBe(' M notes/a.md\n?? b.md');
  });

  test('does not treat look-alike names as metadata', () => {
    expect(isPhysicalRootMetadata('.gbrain-owner.json.bak')).toBe(false);
    expect(isPhysicalRootMetadata('.gbrain-owner-xyz.json')).toBe(false);
    expect(withoutPhysicalRootMetadata('?? gbrain-owner.json')).toBe('?? gbrain-owner.json');
  });
});
