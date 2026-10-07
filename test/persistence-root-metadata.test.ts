/**
 * #5371: the porcelain filter behind the doctor `bootstrap_push_health` and
 * stop-hook dirty probes drops only exact physical-root ownership metadata, so
 * the stamp gbrain writes is not unpushed work while real changes still count.
 */
import { describe, expect, test } from 'bun:test';
import { isPhysicalRootMetadata, withoutPhysicalRootMetadata } from '../src/core/persistence/root-metadata.ts';
import { isPhysicalRootMetadata as viaPhysicalRoot } from '../src/core/persistence/physical-root.ts';

describe('withoutPhysicalRootMetadata', () => {
  const reservation = `.gbrain-owner-${'a'.repeat(64)}.json`;
  const tmpStamp = `.gbrain-owner.json.${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}.tmp`;

  test('drops the ownership stamp, reservation and stamp temp entries at any depth', () => {
    expect(withoutPhysicalRootMetadata(`?? .gbrain-owner.json\n?? brain/.gbrain-owner.json\n?? ${reservation}\n?? ${tmpStamp}\n`)).toBe('');
  });

  test('keeps real changes next to the stamp', () => {
    expect(withoutPhysicalRootMetadata(' M notes/a.md\n?? .gbrain-owner.json\n?? b.md\n')).toBe(' M notes/a.md\n?? b.md');
  });

  test('a rename onto or away from the stamp is still a real change', () => {
    expect(withoutPhysicalRootMetadata('R  notes/a.md -> .gbrain-owner.json\n')).toBe('R  notes/a.md -> .gbrain-owner.json');
    expect(withoutPhysicalRootMetadata('R  .gbrain-owner.json -> notes/a.md\n')).toBe('R  .gbrain-owner.json -> notes/a.md');
  });

  test('does not treat look-alike or quoted names as metadata', () => {
    expect(isPhysicalRootMetadata('.gbrain-owner.json.bak')).toBe(false);
    expect(isPhysicalRootMetadata('.gbrain-owner-xyz.json')).toBe(false);
    expect(isPhysicalRootMetadata('.gbrain-managed')).toBe(false);
    expect(withoutPhysicalRootMetadata('?? gbrain-owner.json')).toBe('?? gbrain-owner.json');
    expect(withoutPhysicalRootMetadata('?? ".gbrain-owner.json "')).toBe('?? ".gbrain-owner.json "');
  });

  test('the physical-root facade re-exports the same predicate', () => {
    expect(viaPhysicalRoot).toBe(isPhysicalRootMetadata);
  });
});
