/**
 * v0.20.0 Cathedral II Layer 5 (A1) — qualified name identity tests.
 *
 * Pins the language-specific delimiter conventions so Ruby ships with
 * `Admin::UsersController#render` identity and doesn't drift toward the
 * Python `.` convention under accident.
 */

import { describe, test, expect } from 'bun:test';
import { buildQualifiedName } from '../src/core/chunkers/qualified-names.ts';

describe('buildQualifiedName — TypeScript', () => {
  test('top-level function returns bare name', () => {
    expect(
      buildQualifiedName({
        language: 'typescript',
        symbolName: 'parseInput',
        symbolType: 'function',
        parentSymbolPath: [],
      }),
    ).toBe('parseInput');
  });

  test('class method joins with dot', () => {
    expect(
      buildQualifiedName({
        language: 'typescript',
        symbolName: 'searchKeyword',
        symbolType: 'method',
        parentSymbolPath: ['BrainEngine'],
      }),
    ).toBe('BrainEngine.searchKeyword');
  });

  test('null symbol returns null', () => {
    expect(
      buildQualifiedName({
        language: 'typescript',
        symbolName: null,
        symbolType: 'merged',
        parentSymbolPath: [],
      }),
    ).toBeNull();
  });
});

describe('buildQualifiedName — Ruby (Garry is a Rubyist)', () => {
  test('instance method uses # delimiter', () => {
    expect(
      buildQualifiedName({
        language: 'ruby',
        symbolName: 'render',
        symbolType: 'function',
        parentSymbolPath: ['Admin', 'UsersController'],
      }),
    ).toBe('Admin::UsersController#render');
  });

  test('nested modules compose with ::', () => {
    expect(
      buildQualifiedName({
        language: 'ruby',
        symbolName: 'find_all',
        symbolType: 'function',
        parentSymbolPath: ['Admin', 'UsersController'],
      }),
    ).toBe('Admin::UsersController#find_all');
  });

  test('top-level module method has no :: prefix', () => {
    expect(
      buildQualifiedName({
        language: 'ruby',
        symbolName: 'render',
        symbolType: 'function',
        parentSymbolPath: [],
      }),
    ).toBe('render');
  });
});

describe('buildQualifiedName — Python', () => {
  test('class method joins with .', () => {
    expect(
      buildQualifiedName({
        language: 'python',
        symbolName: 'get_user',
        symbolType: 'function',
        parentSymbolPath: ['UserService'],
      }),
    ).toBe('UserService.get_user');
  });
});

describe('buildQualifiedName — Rust', () => {
  test('impl method joins with ::', () => {
    expect(
      buildQualifiedName({
        language: 'rust',
        symbolName: 'render',
        symbolType: 'function',
        parentSymbolPath: ['users', 'UsersController'],
      }),
    ).toBe('users::UsersController::render');
  });
});

describe('buildQualifiedName — Java', () => {
  test('class method joins with .', () => {
    expect(
      buildQualifiedName({
        language: 'java',
        symbolName: 'render',
        symbolType: 'method',
        parentSymbolPath: ['com', 'acme', 'UsersController'],
      }),
    ).toBe('com.acme.UsersController.render');
  });
});

describe('buildQualifiedName — unknown language', () => {
  test('falls back to dot-joined path + name (never drops edge)', () => {
    expect(
      buildQualifiedName({
        // @ts-expect-error: testing unknown-language fallback path
        language: 'bogus',
        symbolName: 'helper',
        symbolType: 'function',
        parentSymbolPath: ['ns'],
      }),
    ).toBe('ns.helper');
  });
});
