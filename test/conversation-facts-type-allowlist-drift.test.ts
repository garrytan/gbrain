/**
 * conversation-facts type allowlist — single source of truth + drift guard.
 *
 * The conversation-facts type allowlist (`conversation`, `meeting`, `slack`,
 * `email`, `imessage`, `imessage-daily`) used to be hand-copied into five
 * places across four files:
 *   1. extract-conversation-facts.ts's ALLOWED_TYPES (canonical)
 *   2. doctor.ts's conversation_facts_backlog config default
 *   3. doctor.ts's conversation_format_coverage sample scan
 *   4. jobs.ts's extract-conversation-facts Minion job handler filter
 *   5. sources.ts's facts-backfill audit estimator
 *
 * It had already drifted: jobs.ts's runExtractConversationFactsCore call cast
 * `types` to `('conversation' | 'meeting' | 'slack' | 'email')[] | undefined`
 * — the pre-#2756 four-element set, missing `imessage` and `imessage-daily`
 * that the runtime filter one line above it already accepted. Same class of
 * bug CLAUDE.md calls out for pricing tables: "One canonical ... table ...
 * Every other table is a DERIVED view, never a hand-copied duplicate — so
 * cross-table ... drift is structurally impossible."
 *
 * ALLOWED_TYPES/AllowedType now live in a leaf module,
 * src/core/facts/conversation-types.ts, NOT in extract-conversation-facts.ts
 * (which re-exports both verbatim). That's a second-order fix: sites 2-5
 * originally imported the constant straight from extract-conversation-
 * facts.ts, and scripts/generate-flag-registry.ts scans every relative
 * import of a command module for `--flag`-shaped string literals — so
 * importing anything from that command module (even just this constant)
 * transitively attributed its whole CLI flag surface (`--background`,
 * `--concurrency`, `--limit`, ... about ten flags) to doctor/repos/sources
 * in the generated registry, silently widening what those three commands'
 * strict unknown-flag validation (#2185) accepts (#4135 CI failure). The
 * leaf module has no flags of its own, so importing it doesn't leak
 * anything, regardless of whether the importer uses a static or dynamic
 * import (generate-flag-registry.ts's one-level relative-import scan
 * matches both forms identically).
 *
 * Guards below, mirroring test/model-pricing.test.ts:
 *   - identity/behavioral assertions where a site's resolved list is
 *     reachable at runtime (doctor.ts's backlog-check `details.types`);
 *   - a SEMANTIC hand-copy detector (set-membership over array literals and
 *     string-literal union chains, order- and length-insensitive) for sites
 *     whose list isn't independently reachable/exported. An earlier version
 *     used byte-exact canonical-order regexes, which mutation testing showed
 *     only tripped on an exact canonical-order re-add — permuted re-adds,
 *     subset re-adds (the harmful direction: silently dropping types), and a
 *     narrowed jobs.ts runtime filter all passed. The detector fails on ANY
 *     re-hardcoded conversation-type list (>=2 canonical members, code or
 *     comment) and on pointing a site back at extract-conversation-facts.ts
 *     instead of the leaf. The guarded set includes the cycle backfill phase
 *     (src/core/cycle/conversation-facts-backfill.ts), where the detector
 *     immediately caught a stale pre-#2756 four-element default in the
 *     header comment;
 *   - ALLOWED_TYPES itself is Object.frozen, so runtime mutation throws
 *     instead of silently drifting every derived consumer at once;
 *   - a flag-registry regression guard pinning the exact bug this file's
 *     history hit: doctor/repos/sources must never carry
 *     extract-conversation-facts.ts's own flags.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALLOWED_TYPES } from '../src/core/facts/conversation-types.ts';
import { computeConversationFactsBacklogCheck } from '../src/commands/doctor.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { buildFlagRegistry } from '../scripts/generate-flag-registry.ts';

const EXPECTED_TYPES = [
  'conversation',
  'meeting',
  'slack',
  'email',
  'imessage',
  'imessage-daily',
] as const;

function readSrc(relPath: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${relPath}`, import.meta.url)), 'utf8');
}

// Semantic hand-copy detector (replaces the earlier byte-exact literal/order
// matchers, which only tripped on a canonical-order re-add — a permuted
// re-add, a subset re-add (the harmful direction: silently dropping types),
// and a narrowed runtime filter all sailed past them). Finds EVERY
// conversation-type list shape regardless of order or length:
//   - array literals of >=2 string elements (`['meeting', 'slack', ...]`)
//   - string-literal union chains of >=2 members (`'meeting' | 'slack' | ...`)
// and flags any whose elements intersect the canonical set in >=2 places.
// Set-membership, not sequence match — so permutations, subsets, and
// supersets all trip it. It deliberately scans comments too: a hand-copied
// list in a doc comment goes stale the same way code does (adding this
// detector immediately caught a pre-#2756 four-element default documented in
// conversation-facts-backfill.ts's header while the code default was six).
// The >=2 threshold keeps single-membership arrays like extract-conversation-
// facts.ts's ALLOWED_TYPE_ALIASES values (`['slack', 'slack-dm-day', ...]`,
// one canonical member each) from false-positiving.
const CANONICAL_SET: ReadonlySet<string> = new Set(EXPECTED_TYPES);
const STRING_LIT = `(?:'[^'\\n]*'|"[^"\\n]*")`;
const ARRAY_LIST_RE = new RegExp(
  `\\[\\s*${STRING_LIT}(?:\\s*,\\s*${STRING_LIT})+\\s*,?\\s*\\]`,
  'g',
);
const UNION_LIST_RE = new RegExp(`${STRING_LIT}(?:\\s*\\|\\s*${STRING_LIT})+`, 'g');

function stringElements(listText: string): string[] {
  return [...listText.matchAll(/['"]([^'"\n]*)['"]/g)].map((m) => m[1]);
}

function findSuspectTypeLists(src: string): Array<{ snippet: string; elements: string[] }> {
  const suspects: Array<{ snippet: string; elements: string[] }> = [];
  for (const re of [ARRAY_LIST_RE, UNION_LIST_RE]) {
    for (const m of src.matchAll(re)) {
      const elements = stringElements(m[0]);
      const canonicalHits = elements.filter((e) => CANONICAL_SET.has(e));
      if (canonicalHits.length >= 2) suspects.push({ snippet: m[0], elements });
    }
  }
  return suspects;
}

// Any import (static `from '...'` or dynamic `import('...')`) of
// ALLOWED_TYPES (optionally aliased) from the given relative module path.
function countAllowedTypesImportsFrom(src: string, modulePathEscaped: string): number {
  const staticRe = new RegExp(
    `import\\s*\\{[^}]*\\bALLOWED_TYPES\\b[^}]*\\}\\s*from\\s*['"]${modulePathEscaped}['"]`,
    'g',
  );
  const dynamicRe = new RegExp(
    `\\{\\s*[^}]*\\bALLOWED_TYPES\\b[^}]*\\}\\s*=\\s*await\\s+import\\(\\s*['"]${modulePathEscaped}['"]\\s*\\)`,
    'g',
  );
  return [...src.matchAll(staticRe)].length + [...src.matchAll(dynamicRe)].length;
}

// A site still pointed at extract-conversation-facts.ts for ALLOWED_TYPES
// (the exact regression this file's history hit) rather than the leaf.
function countAllowedTypesImportsFromCommandModule(src: string): number {
  return countAllowedTypesImportsFrom(src, '\\.\\/extract-conversation-facts\\.ts');
}

describe('ALLOWED_TYPES — canonical source of truth (leaf module)', () => {
  test('has exactly the 6 expected types, in order', () => {
    expect([...ALLOWED_TYPES]).toEqual([...EXPECTED_TYPES]);
  });

  test('is Object.frozen — runtime mutation throws instead of silently drifting every consumer', () => {
    expect(Object.isFrozen(ALLOWED_TYPES)).toBe(true);
    // Module code runs in strict mode, so a frozen-array write throws
    // (it would be a silent no-op in sloppy mode — assert the throw so the
    // guard is about behavior, not just the flag).
    expect(() => {
      (ALLOWED_TYPES as unknown as string[]).push('sms');
    }).toThrow();
    expect(ALLOWED_TYPES.length).toBe(6);
  });

  test('exactly one conversation-type list exists in the leaf module, and it is set-equal to the canonical 6', () => {
    const src = readSrc('core/facts/conversation-types.ts');
    const suspects = findSuspectTypeLists(src);
    expect(suspects.length).toBe(1);
    expect([...suspects[0].elements].sort()).toEqual([...EXPECTED_TYPES].sort());
  });

  test('the leaf module carries no CLI-flag-shaped literals of its own', () => {
    // This is the actual invariant the leaf module exists to guarantee: it
    // must never gain a `--flag`-shaped string (e.g. from a comment example
    // or a hand-added constant), or generate-flag-registry.ts's relative-
    // import scan would once again attribute flags to every consumer that
    // imports ALLOWED_TYPES from here — reopening #4135.
    const src = readSrc('core/facts/conversation-types.ts');
    expect([...src.matchAll(/--[a-z0-9][a-z0-9-]*/g)]).toEqual([]);
  });

  test('extract-conversation-facts.ts no longer hand-copies any type list; re-exports from the leaf', () => {
    const src = readSrc('commands/extract-conversation-facts.ts');
    expect(findSuspectTypeLists(src)).toEqual([]);
    expect(countAllowedTypesImportsFrom(src, '\\.\\./core/facts/conversation-types\\.ts')).toBe(1);
    expect(src).toContain('export { ALLOWED_TYPES }');
    expect(src).toContain('export type { AllowedType }');
  });
});

describe('DRIFT GUARD — consumer sites derive from the leaf module (re-hardcode + wrong-import trip-wire)', () => {
  for (const [label, relPath] of [
    ['doctor.ts', 'commands/doctor.ts'],
    ['conversation-coverage.ts', 'commands/doctor/checks/conversation-coverage.ts'],
    ['jobs.ts', 'commands/jobs.ts'],
    ['sources.ts', 'commands/sources.ts'],
    ['conversation-facts-backfill.ts', 'core/cycle/conversation-facts-backfill.ts'],
  ] as const) {
    test(`${label}: no hand-copied conversation-type list remains (any order, any length >= 2)`, () => {
      // Set-membership detector, NOT a canonical-order literal match: a
      // permuted re-add, a subset re-add (dropping a type), and a widened
      // re-add all fail here. Code and comments alike.
      const src = readSrc(relPath);
      expect(findSuspectTypeLists(src)).toEqual([]);
    });

    test(`${label}: does not import ALLOWED_TYPES from extract-conversation-facts.ts`, () => {
      const src = readSrc(relPath);
      expect(
        countAllowedTypesImportsFrom(src, '\\.\\.?(?:/\\.\\.)?/commands/extract-conversation-facts\\.ts') +
          countAllowedTypesImportsFromCommandModule(src),
      ).toBe(0);
    });
  }

  test('conversation-facts-backfill.ts: imports ALLOWED_TYPES from the leaf exactly once', () => {
    const src = readSrc('core/cycle/conversation-facts-backfill.ts');
    expect(countAllowedTypesImportsFrom(src, '\\.\\./facts/conversation-types\\.ts')).toBe(1);
  });

  test('doctor.ts: no longer imports ALLOWED_TYPES (all call sites peeled)', () => {
    // The backlog check moved to doctor/checks/search-eval.ts and the
    // parser-sample scan (conversation_format_coverage, #4193) moved to
    // doctor/checks/conversation-coverage.ts; each is guarded separately.
    const src = readSrc('commands/doctor.ts');
    expect(countAllowedTypesImportsFrom(src, '\\.\\./core/facts/conversation-types\\.ts')).toBe(0);
    expect((src.match(/\bALLOWED_TYPES\b/g) ?? []).length).toBe(0);
  });

  test('doctor/checks/conversation-coverage.ts: the peeled coverage check derives from the leaf', () => {
    const src = readSrc('commands/doctor/checks/conversation-coverage.ts');
    expect(countAllowedTypesImportsFrom(src, '\\.\\./\\.\\./\\.\\./core/facts/conversation-types\\.ts')).toBe(1);
    expect((src.match(/\bALLOWED_TYPES\b/g) ?? []).length).toBeGreaterThanOrEqual(2); // import + 1 usage
  });

  test('doctor/checks/search-eval.ts: the peeled backlog check derives from the leaf too', () => {
    const src = readSrc('commands/doctor/checks/search-eval.ts');
    expect(countAllowedTypesImportsFrom(src, '\\.\\./\\.\\./\\.\\./core/facts/conversation-types\\.ts')).toBe(1);
    expect((src.match(/\bALLOWED_TYPES\b/g) ?? []).length).toBeGreaterThanOrEqual(2); // import + 1 usage
  });

  test('jobs.ts: the extract-conversation-facts handler filters job.data.types against ALLOWED_TYPES', () => {
    // Closes the narrowed-runtime-filter hole: the `job.data.types` filter
    // must reference the canonical ALLOWED_TYPES binding. Together with the
    // hand-copy detector above (no shadow list may exist anywhere in
    // jobs.ts) and the single-leaf-import guard below, narrowing the filter
    // requires either dropping this reference (fails here) or re-adding a
    // hand-copied list (fails the detector). The old guard was a byte-exact
    // match on the stale 4-element union cast, which a 4-element runtime
    // filter re-add sailed straight past.
    const src = readSrc('commands/jobs.ts');
    expect(src).toMatch(/job\.data\.types[\s\S]{0,400}?\bALLOWED_TYPES\b/);
  });

  test('jobs.ts: imports ALLOWED_TYPES + AllowedType from the leaf exactly once', () => {
    const src = readSrc('commands/jobs.ts');
    expect(countAllowedTypesImportsFrom(src, '\\.\\./core/facts/conversation-types\\.ts')).toBe(1);
    expect(src).toContain("type AllowedType } from '../core/facts/conversation-types.ts'");
  });

  test('sources.ts: FACTS_BACKFILL_ALLOWED imports ALLOWED_TYPES from the leaf', () => {
    const src = readSrc('commands/sources.ts');
    expect(countAllowedTypesImportsFrom(src, '\\.\\./core/facts/conversation-types\\.ts')).toBe(1);
  });
});

describe('DRIFT GUARD — jobs.ts filter accepts all 6 canonical types at runtime', () => {
  // jobs.ts's filter is `(t): t is AllowedType => (ALLOWED_TYPES as readonly
  // string[]).includes(t)` — the same predicate shape as
  // extract-conversation-facts.ts's own resolveTypesFromConfig filter. Since
  // the source-text guard above proves jobs.ts's filter is wired to the
  // canonical ALLOWED_TYPES (not a hand-copied duplicate), proving
  // ALLOWED_TYPES itself accepts every canonical type closes the loop:
  // jobs.ts accepts all 6, including `imessage`/`imessage-daily`, which the
  // stale cast's *type* (but not its runtime behavior — see the commit
  // message) used to exclude.
  test('ALLOWED_TYPES accepts every canonical type via .includes()', () => {
    for (const t of EXPECTED_TYPES) {
      expect((ALLOWED_TYPES as readonly string[]).includes(t)).toBe(true);
    }
  });
});

describe('DRIFT GUARD — doctor.ts conversation_facts_backlog default is reachable + correct', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('with no cycle.conversation_facts_backfill.types override, the resolved default equals ALLOWED_TYPES', async () => {
    await resetPgliteState(engine);
    await engine.setConfig('cycle.conversation_facts_backfill.enabled', 'true');
    // No pages of any conversation type exist, so backlog === 0 and the
    // check takes the 'ok' branch, which reports the resolved `types` it
    // used in `details.types` — the actual default this code path runs
    // with, not a value we're asserting in isolation.
    const check = await computeConversationFactsBacklogCheck(engine);
    expect(check.status).toBe('ok');
    const resolvedTypes = (check.details as { types?: string[] } | undefined)?.types;
    expect(resolvedTypes).toBeDefined();
    expect([...(resolvedTypes ?? [])].sort()).toEqual([...EXPECTED_TYPES].sort());
  });
});

describe('DRIFT GUARD — #4135 regression: doctor.ts/sources.ts never relative-import extract-conversation-facts.ts', () => {
  // The exact bug: doctor.ts (both sites) and sources.ts each imported
  // ALLOWED_TYPES straight from extract-conversation-facts.ts.
  // generate-flag-registry.ts's one-level relative-import scan
  // (`from '...'` AND `import('...')`, matched identically) then read that
  // whole command module's text for `--flag`-shaped literals and folded
  // them into doctor/repos/sources's registry entries — silently widening
  // what those commands' #2185 strict unknown-flag validation accepts.
  // Reproduces the generator's own relative-import regex (scripts/
  // generate-flag-registry.ts:relativeImports) rather than guessing which
  // flag names are "foreign": other legitimately-imported modules can
  // independently contribute overlapping flag names, so a flag-allowlist
  // test would be both wrong and fragile. jobs.ts is deliberately excluded:
  // it independently, legitimately imports extract-conversation-facts.ts
  // for runExtractConversationFactsCore, so its registry entry already (and
  // correctly) carries that command's flag surface — see the "no #2756-
  // drift-class" jobs.ts guards above for what DOES need to hold there.
  const RELATIVE_IMPORT_RE = /(?:from\s+'(\.\.?\/[^']+\.ts)'|import\('(\.\.?\/[^']+\.ts)'\))/g;

  function relativeImportPaths(src: string): string[] {
    return [...src.matchAll(RELATIVE_IMPORT_RE)].map((m) => m[1] ?? m[2]);
  }

  for (const [label, relPath] of [
    ['doctor.ts', 'commands/doctor.ts'],
    ['sources.ts', 'commands/sources.ts'],
  ] as const) {
    test(`${label}: source contains no relative import path ending in extract-conversation-facts.ts`, () => {
      const src = readSrc(relPath);
      const hits = relativeImportPaths(src).filter((p) => p.endsWith('extract-conversation-facts.ts'));
      expect(hits).toEqual([]);
    });
  }

  test('flag-registry freshness: rebuilding the registry now produces the exact same doctor/repos/sources/jobs entries as committed', () => {
    // Narrow, targeted companion to test/cli-flag-validation.test.ts's
    // whole-registry freshness guard (#2185) — pinned specifically to the
    // four command names this bug touched (or, for jobs, deliberately did
    // NOT touch), so a regression here fails right next to its cause.
    const registry = buildFlagRegistry();
    const committedSrc = readSrc('core/cli-flag-registry.generated.ts');
    for (const command of ['doctor', 'repos', 'sources', 'jobs']) {
      const entryMatch = committedSrc.match(
        new RegExp(`'${command}': \\[([^\\]]*)\\]`),
      );
      expect(entryMatch, `no committed registry entry found for '${command}'`).not.toBeNull();
      const committedFlags = [...(entryMatch![1].matchAll(/'([^']+)'/g))].map((m) => m[1]).sort();
      expect(registry[command]).toEqual(committedFlags);
    }
  });
});
