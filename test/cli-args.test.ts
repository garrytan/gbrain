import { describe, expect, test } from 'bun:test';
import { findUnknownOpFlag, parseOpArgs } from '../src/cli.ts';
import { operations, operationsByName } from '../src/core/operations.ts';

describe('parseOpArgs', () => {
  test('--no-<boolean> maps to false without consuming the next flag', () => {
    const params = parseOpArgs(operationsByName.query, [
      'freshEmbedSourceScope code source',
      '--limit',
      '8',
      '--no-expand',
      '--source-id',
      'gstack-code-repo-0e4763c9',
    ]);

    expect(params).toEqual({
      query: 'freshEmbedSourceScope code source',
      limit: 8,
      expand: false,
      source_id: 'gstack-code-repo-0e4763c9',
    });
  });
});

// #4602 — `--flag false` on a boolean param used to set the flag TRUE (silent
// intent inversion, exit 0, nothing on stderr) and leave the literal 'false'
// to bind to the next unfilled positional slot (data corruption on
// multi-positional ops: `link a --json false` bound to:"false"). A literal
// true/false following a boolean flag is now consumed as that flag's value,
// exactly like the `--flag=false` inline form that already worked.
describe('#4602 — boolean flags consume a literal true/false value token', () => {
  test('the headline case: query --expand false means expand OFF', () => {
    const params = parseOpArgs(operationsByName.query, ['probe text here', '--expand', 'false']);
    expect(params).toEqual({ query: 'probe text here', expand: false });
  });

  test('--expand true is honored too, and following flags still parse', () => {
    const params = parseOpArgs(operationsByName.query, [
      'probe text here', '--expand', 'false', '--limit', '5',
    ]);
    expect(params).toEqual({ query: 'probe text here', expand: false, limit: 5 });
  });

  test('table-driven: every boolean param on every op consumes a literal false (and true)', () => {
    for (const op of operations) {
      for (const [key, def] of Object.entries(op.params)) {
        if (def.type !== 'boolean') continue;
        const flag = `--${key.replace(/_/g, '-')}`;
        for (const literal of ['false', 'true'] as const) {
          const params = parseOpArgs(op, [flag, literal]);
          expect(params[key]).toBe(literal === 'true');
          // The literal must never leak into a positional slot.
          for (const [k, v] of Object.entries(params)) {
            if (k === key) continue;
            expect(v).not.toBe(literal);
          }
          // The validator considers the consumed form clean.
          expect(findUnknownOpFlag(op, [flag, literal])).toBeNull();
        }
      }
    }
  });

  test('table-driven: --json/--dry-run + literal false never binds to a positional on any op', () => {
    for (const op of operations) {
      for (const flag of ['--json', '--dry-run'] as const) {
        const key = flag === '--json' ? 'json' : 'dry_run';
        const params = parseOpArgs(op, [flag, 'false']);
        expect(params[key]).toBe(false);
        for (const [k, v] of Object.entries(params)) {
          if (k === key) continue;
          expect(v).not.toBe('false');
        }
        expect(findUnknownOpFlag(op, [flag, 'false'])).toBeNull();
      }
    }
  });

  test('validator arm: --dry-run true is a consumed value token, not an unknown flag or a positional', () => {
    // The parser and the validator share ONE isBooleanLiteral definition; the
    // `true` literal is the arm the table-driven --dry-run case above does not
    // exercise. Pinned on a multi-positional op so a leak would be visible.
    expect(findUnknownOpFlag(operationsByName.add_link, ['page-a', '--dry-run', 'true', 'page-b'])).toBeNull();
    const params = parseOpArgs(operationsByName.add_link, ['page-a', '--dry-run', 'true', 'page-b']);
    expect(params).toEqual({ from: 'page-a', dry_run: true, to: 'page-b' });
    // Inline spelling stays consumed too, and never eats the next token.
    expect(findUnknownOpFlag(operationsByName.add_link, ['page-a', '--dry-run=true', 'page-b'])).toBeNull();
  });

  test('multi-positional op: link a --json false no longer binds to:"false"', () => {
    const params = parseOpArgs(operationsByName.add_link, ['page-a', '--json', 'false']);
    expect(params).toEqual({ from: 'page-a', json: false });
  });

  test('multi-positional write op: entity-identity-link --canonical false no longer binds slug:"false"', () => {
    const params = parseOpArgs(operationsByName.entity_identity_link, ['ent-1', '--canonical', 'false']);
    expect(params).toEqual({ entity_id: 'ent-1', canonical: false });
  });

  test('a non-true/false token after a boolean flag still binds positionally (unchanged)', () => {
    const params = parseOpArgs(operationsByName.add_link, ['page-a', '--json', 'page-b']);
    expect(params).toEqual({ from: 'page-a', json: true, to: 'page-b' });
  });

  test('bare boolean flag at end of argv still means true (unchanged)', () => {
    const params = parseOpArgs(operationsByName.query, ['probe text here', '--expand']);
    expect(params).toEqual({ query: 'probe text here', expand: true });
    const trailing = parseOpArgs(operationsByName.add_link, ['page-a', 'page-b', '--dry-run']);
    expect(trailing).toEqual({ from: 'page-a', to: 'page-b', dry_run: true });
  });

  test('--json=false inline form keeps its existing semantics (unchanged)', () => {
    const params = parseOpArgs(operationsByName.add_link, ['page-a', 'page-b', '--json=false']);
    expect(params).toEqual({ from: 'page-a', to: 'page-b', json: false });
  });
});

