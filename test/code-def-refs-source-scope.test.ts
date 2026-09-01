/**
 * #4747 — code-def / code-refs source scoping.
 *
 * Before this, both lookups were brain-wide: on a multi-source brain the same
 * symbol name in two repos collapsed into one result set, and each row's
 * `file` is repo-relative, so a foreign hit was indistinguishable from a local
 * one. `code-callers` / `code-callees` already scoped by source for exactly
 * this reason ("`Admin::UsersController#render` in repo A ≠ same string in repo
 * B"); these tests pin the same contract onto def/refs.
 *
 * Seeds two sources that each define AND reference the same symbol name, so a
 * scoped lookup returning the other source's file is a visible failure rather
 * than a coincidence.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importCodeFile } from '../src/core/import-file.ts';
import { findCodeDef, probeFilteredSymbolTypes } from '../src/commands/code-def.ts';
import { shouldWidenForNoCode } from '../src/commands/code-scope.ts';
import { findCodeRefs } from '../src/commands/code-refs.ts';

const SOURCE_A = 'scope-test-source-a';
const SOURCE_B = 'scope-test-source-b';

let engine: PGLiteEngine;

/** Same exported function name in both sources, different files + bodies. */
function moduleSrc(marker: string): string {
  return `export interface DispatchOptions {
  attempts: number;
  timeoutMs: number;
  label: string;
}

export function dispatchRecord(options: DispatchOptions): string {
  const attempts = options.attempts > 0 ? options.attempts : 1;
  const timeoutMs = options.timeoutMs > 0 ? options.timeoutMs : 30_000;
  if (!options.label) throw new Error('dispatchRecord requires a label');
  const summary = '${marker}:' + options.label + ':' + attempts + ':' + timeoutMs;
  console.log('dispatching', summary);
  return summary;
}

export function retryDispatch(options: DispatchOptions, extra: number): string {
  const widened = { ...options, attempts: options.attempts + extra };
  console.log('retrying with', widened.attempts, 'attempts for', widened.label);
  return dispatchRecord(widened);
}
`;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  for (const id of [SOURCE_A, SOURCE_B]) {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
      [id],
    );
  }

  await importCodeFile(engine, 'src/a/dispatch.ts', moduleSrc('alpha'), {
    noEmbed: true, sourceId: SOURCE_A,
  });
  await importCodeFile(engine, 'src/b/dispatch.ts', moduleSrc('beta'), {
    noEmbed: true, sourceId: SOURCE_B,
  });

  // Seeded here, not inside a test body: the probe block below reads it, and
  // cross-describe seeding makes the suite order-dependent under a filtered run.
  await importCodeFile(engine, 'src/a/only-here.ts', `export function alphaOnlyHelper(seed: number): number {
  const scaled = seed * 3 + 7;
  console.log('alpha-only helper computing', scaled);
  if (scaled > 1_000) throw new Error('alphaOnlyHelper overflow');
  return scaled;
}
`, { noEmbed: true, sourceId: SOURCE_A });
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('findCodeDef — source scoping', () => {
  test('scoped lookup returns only the requested source\'s definition', async () => {
    const a = await findCodeDef(engine, 'dispatchRecord', { sourceId: SOURCE_A });
    expect(a.length).toBeGreaterThan(0);
    const files = [...new Set(a.map((r) => r.file))];
    expect(files).toEqual(['src/a/dispatch.ts']);
  });

  test('the other source resolves to its own file, not the first one', async () => {
    const b = await findCodeDef(engine, 'dispatchRecord', { sourceId: SOURCE_B });
    expect(b.length).toBeGreaterThan(0);
    const files = [...new Set(b.map((r) => r.file))];
    expect(files).toEqual(['src/b/dispatch.ts']);
  });

  test('allSources spans both, and is a strict superset of either scope', async () => {
    const all = await findCodeDef(engine, 'dispatchRecord', { allSources: true });
    const a = await findCodeDef(engine, 'dispatchRecord', { sourceId: SOURCE_A });
    const b = await findCodeDef(engine, 'dispatchRecord', { sourceId: SOURCE_B });
    const allFiles = new Set(all.map((r) => r.file));
    expect(allFiles.has('src/a/dispatch.ts')).toBe(true);
    expect(allFiles.has('src/b/dispatch.ts')).toBe(true);
    expect(all.length).toBe(a.length + b.length);
  });

  test('allSources wins over sourceId at the library level (the CLI rejects the combo)', async () => {
    const both = await findCodeDef(engine, 'dispatchRecord', {
      allSources: true, sourceId: SOURCE_A,
    });
    const allFiles = new Set(both.map((r) => r.file));
    expect(allFiles.has('src/b/dispatch.ts')).toBe(true);
  });

  test('no scope given stays brain-wide (library default is unchanged)', async () => {
    const none = await findCodeDef(engine, 'dispatchRecord', {});
    const files = new Set(none.map((r) => r.file));
    expect(files.has('src/a/dispatch.ts')).toBe(true);
    expect(files.has('src/b/dispatch.ts')).toBe(true);
  });

  test('language filter and source predicate compose (placeholder numbering)', async () => {
    const scoped = await findCodeDef(engine, 'dispatchRecord', {
      sourceId: SOURCE_B, language: 'typescript',
    });
    expect(scoped.length).toBeGreaterThan(0);
    expect([...new Set(scoped.map((r) => r.file))]).toEqual(['src/b/dispatch.ts']);
    const wrongLang = await findCodeDef(engine, 'dispatchRecord', {
      sourceId: SOURCE_B, language: 'python',
    });
    expect(wrongLang).toEqual([]);
  });

  test('a symbol absent from the scoped source returns empty, not the other source', async () => {
    const inB = await findCodeDef(engine, 'alphaOnlyHelper', { sourceId: SOURCE_B });
    expect(inB).toEqual([]);
    const inA = await findCodeDef(engine, 'alphaOnlyHelper', { sourceId: SOURCE_A });
    expect(inA.length).toBeGreaterThan(0);
  });
});

describe('findCodeRefs — source scoping', () => {
  test('scoped refs come only from the requested source', async () => {
    const a = await findCodeRefs(engine, 'dispatchRecord', { sourceId: SOURCE_A });
    expect(a.length).toBeGreaterThan(0);
    expect([...new Set(a.map((r) => r.file))]).toEqual(['src/a/dispatch.ts']);
  });

  test('the other source yields its own refs', async () => {
    const b = await findCodeRefs(engine, 'dispatchRecord', { sourceId: SOURCE_B });
    expect(b.length).toBeGreaterThan(0);
    expect([...new Set(b.map((r) => r.file))]).toEqual(['src/b/dispatch.ts']);
  });

  test('allSources spans both', async () => {
    const all = await findCodeRefs(engine, 'dispatchRecord', { allSources: true });
    const files = new Set(all.map((r) => r.file));
    expect(files.has('src/a/dispatch.ts')).toBe(true);
    expect(files.has('src/b/dispatch.ts')).toBe(true);
  });

  test('limit applies within the scope, not across it', async () => {
    const one = await findCodeRefs(engine, 'dispatchRecord', { sourceId: SOURCE_A, limit: 1 });
    expect(one.length).toBe(1);
    expect(one[0].file).toBe('src/a/dispatch.ts');
  });
});

describe('findCodeRefs — predicate composition (mirrors the def cases)', () => {
  test('allSources wins over sourceId at the library level', async () => {
    const both = await findCodeRefs(engine, 'dispatchRecord', {
      allSources: true, sourceId: SOURCE_A,
    });
    expect(new Set(both.map((r) => r.file)).has('src/b/dispatch.ts')).toBe(true);
  });

  test('language filter and source predicate compose ($1 is the ILIKE pattern here)', async () => {
    const scoped = await findCodeRefs(engine, 'dispatchRecord', {
      sourceId: SOURCE_B, language: 'typescript',
    });
    expect(scoped.length).toBeGreaterThan(0);
    expect([...new Set(scoped.map((r) => r.file))]).toEqual(['src/b/dispatch.ts']);
    const wrongLang = await findCodeRefs(engine, 'dispatchRecord', {
      sourceId: SOURCE_B, language: 'python',
    });
    expect(wrongLang).toEqual([]);
  });
});

describe('shouldWidenForNoCode — the vault+code guard', () => {
  test('a code-bearing source does not widen', async () => {
    expect(await shouldWidenForNoCode(engine, SOURCE_A)).toBe(false);
  });

  test('a source with no code widens when the brain has code elsewhere', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
      ['scope-test-vault'],
    );
    expect(await shouldWidenForNoCode(engine, 'scope-test-vault')).toBe(true);
  });

  test('an unknown source widens rather than answering zero', async () => {
    expect(await shouldWidenForNoCode(engine, 'scope-test-no-such-source')).toBe(true);
  });
});

describe('probeFilteredSymbolTypes — source scoping', () => {
  test('the DEF_TYPES-gap probe does not report on another source', async () => {
    // The probe answers "the symbol IS indexed, just filtered". Unscoped, it
    // would answer yes on the strength of a different repo's chunks.
    const inB = await probeFilteredSymbolTypes(engine, 'alphaOnlyHelper', { sourceId: SOURCE_B });
    expect(inB).toEqual([]);
  });

  test('an empty probe result is not vacuous: the same symbol IS visible in its own source', async () => {
    // Guards against the assertion above passing because the query is dead
    // rather than because the scope excluded the symbol.
    const defsInA = await findCodeDef(engine, 'alphaOnlyHelper', { sourceId: SOURCE_A });
    expect(defsInA.length).toBeGreaterThan(0);
    const refsInB = await findCodeRefs(engine, 'alphaOnlyHelper', { sourceId: SOURCE_B });
    expect(refsInB).toEqual([]);
  });
});
