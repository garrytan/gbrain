import { expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';

test('structural graph operations are registered with CLI hints', () => {
  const neighbors = operations.find((operation) => operation.name === 'get_note_structural_neighbors');
  const path = operations.find((operation) => operation.name === 'find_note_structural_path');

  expect(neighbors?.cliHints?.name).toBe('section-neighbors');
  expect(path?.cliHints?.name).toBe('section-path');
});
