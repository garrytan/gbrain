import { expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';

test('note section operations are registered with CLI hints', () => {
  const get = operations.find((operation) => operation.name === 'get_note_section_entry');
  const list = operations.find((operation) => operation.name === 'list_note_section_entries');
  const rebuild = operations.find((operation) => operation.name === 'rebuild_note_sections');

  expect(get?.cliHints?.name).toBe('section-get');
  expect(list?.cliHints?.name).toBe('section-list');
  expect(rebuild?.cliHints?.name).toBe('section-rebuild');
});
