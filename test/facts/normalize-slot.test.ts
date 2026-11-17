/**
 * GBRA-574: normalizeSlot is the gate every stored conversation slot passes through (conversation-publication.ts
 * insertableSlots). The extractor no longer asks for slots, so these cases call it directly.
 */
import { describe, expect, test } from 'bun:test';
import { normalizeSlot } from '../../src/core/facts/slots.ts';

const ALICE = 'people/alice-example';

describe('normalizeSlot', () => {
  test('keeps a valid slot with aliases normalized and the value trimmed', () => {
    expect(normalizeSlot('Company', '  Acme Example ', ALICE)).toEqual({ dimension: 'employer', value: 'Acme Example' });
    expect(normalizeSlot('location', 'Springfield', ALICE)).toEqual({ dimension: 'location', value: 'Springfield' });
    expect(normalizeSlot('job title', 'head of design', ALICE)).toEqual({ dimension: 'role', value: 'head of design' });
  });

  test('keeps an 80-character value and drops an 81-character one', () => {
    expect(normalizeSlot('role', 'y'.repeat(80), ALICE)).toEqual({ dimension: 'role', value: 'y'.repeat(80) });
    expect(normalizeSlot('role', 'x'.repeat(81), ALICE)).toBeNull();
  });

  test('drops a dimension outside the vocabulary, a blank or non-string value, and a slot with no entity', () => {
    expect(normalizeSlot('hobby', 'chess', ALICE)).toBeNull();
    expect(normalizeSlot('location', '   ', ALICE)).toBeNull();
    expect(normalizeSlot('role', 7, ALICE)).toBeNull();
    expect(normalizeSlot(undefined, 'Acme Example', ALICE)).toBeNull();
    expect(normalizeSlot('employer', 'Acme Example', null)).toBeNull();
  });
});
