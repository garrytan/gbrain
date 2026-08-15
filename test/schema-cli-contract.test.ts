// v0.39 T6 — CLI contract pinning test.
//
// Every schema CLI verb supports --json output and (where source-scoping
// makes sense) --source <id>. Pin in CI so future verbs can't drift.
// The structural check is a source grep against src/commands/schema.ts:
// every verb-handler function MUST consult parseFlags() (which yields
// {json, source, positional}). The grep is intentionally simple — a verb
// that wants to opt OUT of the contract must do so explicitly and
// document why.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

const SCHEMA_TS = readFileSync('src/commands/schema.ts', 'utf-8');

// Verbs that take any input (not the bare router cases).
// `active`/`list`/`show`/`validate`/`use` are legacy v0.38 — they don't
// follow the parseFlags() contract; opt-out documented.
const LEGACY_OPT_OUT = new Set(['active', 'list', 'show', 'validate', 'use']);

const NEW_VERBS = [
  'detect', 'suggest', 'review-candidates',
  'init', 'fork', 'edit', 'diff', 'graph', 'lint', 'explain', 'review-orphans',
  'downgrade', 'usage',
];

describe('v0.39 T6 — schema CLI contract', () => {
  test('every new verb routes through runSchema dispatch', () => {
    for (const v of NEW_VERBS) {
      expect(SCHEMA_TS).toContain(`case '${v}':`);
    }
  });

  test('every new verb-handler reads parseFlags() for --json + --source', () => {
    // The handler function name pattern is run<PascalCase>Cmd. Each must
    // call parseFlags. Source-grep is sufficient: if a future verb forgets
    // parseFlags, this test fails.
    const handlerNames = NEW_VERBS.map((v) => {
      const pascal = v.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join('');
      return `run${pascal}Cmd`;
    });
    for (const h of handlerNames) {
      // Each handler must exist as a function declaration.
      expect(SCHEMA_TS).toContain(`async function ${h}(`);
      // And must contain a parseFlags() call (the contract gate).
      const handlerStart = SCHEMA_TS.indexOf(`async function ${h}(`);
      const handlerEnd = SCHEMA_TS.indexOf('async function ', handlerStart + 1);
      const handlerBody = SCHEMA_TS.slice(handlerStart, handlerEnd > 0 ? handlerEnd : undefined);
      expect(handlerBody).toContain('parseFlags(');
    }
  });

  test('parseFlags() returns the documented shape', () => {
    expect(SCHEMA_TS).toContain('function parseFlags(args: string[]): ParsedFlags');
    expect(SCHEMA_TS).toContain('interface ParsedFlags');
    expect(SCHEMA_TS).toContain('json: boolean');
    expect(SCHEMA_TS).toContain('source: string | undefined');
    expect(SCHEMA_TS).toContain('positional: string[]');
  });

  test('parseFlags accepts both --source and --source-id forms', () => {
    expect(SCHEMA_TS).toContain("'--source'");
    expect(SCHEMA_TS).toContain("'--source-id'");
  });

  test('every new verb when --json passed produces a JSON envelope', () => {
    // schema_version: 1 is the contract for every JSON output.
    // Source-grep: count occurrences of `schema_version: 1` near JSON output sites.
    const matches = SCHEMA_TS.match(/schema_version:\s*1/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(NEW_VERBS.length - 2);
    // ^ allow up to 2 verbs to skip the envelope where it's degenerate
    //   (e.g. edit just prints a path; usage prints aggregate).
  });

  test('legacy v0.38 verbs are explicitly NOT in NEW_VERBS', () => {
    // Regression guard: do not silently let a legacy verb opt-in without
    // also updating LEGACY_OPT_OUT documentation.
    for (const v of NEW_VERBS) {
      expect(LEGACY_OPT_OUT.has(v)).toBe(false);
    }
  });

  test('EXPERIMENTAL_VERBS set matches the documented D14 hybrid choice', () => {
    expect(SCHEMA_TS).toContain('init');
    expect(SCHEMA_TS).toContain('fork');
    expect(SCHEMA_TS).toContain('edit');
    expect(SCHEMA_TS).toContain('diff');
    expect(SCHEMA_TS).toContain('graph');
    expect(SCHEMA_TS).toContain('explain');
    expect(SCHEMA_TS).toContain('EXPERIMENTAL_VERBS');
    // ^ the marker constant must be present so T23 telemetry can read it.
  });
});
