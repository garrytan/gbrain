/**
 * #6953: the pack's person-like types are `person` plus every type that
 * aliases it, not every type sharing person's primitive. Kept apart from
 * test/edge-employment-roles.test.ts so that file's behavioral assertions load
 * and run on a tree without this helper.
 */
import { describe, expect, test } from 'bun:test';
import { personTypesFromPack } from '../src/core/schema-pack/entity-types.ts';

describe('personTypesFromPack', () => {
  test('person-like types are person plus its alias closure, not primitive siblings', () => {
    const pack = { page_types: [
      { name: 'person', primitive: 'entity', aliases: [] },
      { name: 'researcher', primitive: 'entity', aliases: ['person'] },
      { name: 'lab', primitive: 'entity', aliases: [] },
    ] } as never;
    expect(personTypesFromPack(pack)).toEqual(['person', 'researcher']);
    expect(personTypesFromPack({ page_types: [] } as never)).toEqual(['person']);
  });
});
