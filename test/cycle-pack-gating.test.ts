// v0.41 T9 R-GATE — orchestrator-level pack gate for lens-pack phases.
//
// IRON-RULE regression pinning:
//   1. ALL_PHASES includes 'extract_atoms' (after extract_facts) and
//      'synthesize_concepts' (after patterns).
//   2. PHASE_SCOPE declares extract_atoms='source', synthesize_concepts='global'.
//   3. NEEDS_LOCK_PHASES includes both (they mutate DB via put_page).
//   4. cycle.ts dispatch contains the packDeclaresPhase gate for both
//      new phases (source-shape assertion — pins the not_in_active_pack
//      semantics against future drift).
//   5. Pre-existing 17 core phases ALWAYS run regardless of active pack —
//      only the 2 new lens-pack phases are gated (source-shape regression).
//   6. borrow_from does NOT borrow phases — gbrain-everything explicitly
//      re-declares creator's phases per D4-B (verified in T4 test;
//      cross-referenced here as a pinning hint via source grep).
//
// Why static-source assertions in addition to runtime tests: cycle.ts is a
// ~1700-line orchestrator and the dispatch logic for these new phases
// follows a load-bearing pattern (`if (phases.includes(X)) { ... if
// (!await packDeclaresPhase(engine, X)) skipped else dispatch }`). Static
// source pinning catches refactors that accidentally drop the gate while
// still passing happy-path runtime tests.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ALL_PHASES, PHASE_SCOPE, type CyclePhase } from '../src/core/cycle.ts';

const here = dirname(fileURLToPath(import.meta.url));
const cycleTsSrc = readFileSync(
  join(here, '..', 'src', 'core', 'cycle.ts'),
  'utf-8',
);

const NEW_PHASES: ReadonlyArray<CyclePhase> = ['extract_atoms', 'synthesize_concepts'];

describe('v0.41 T9 R-GATE: ALL_PHASES + PHASE_SCOPE contract', () => {
  test('ALL_PHASES contains extract_atoms', () => {
    expect(ALL_PHASES).toContain('extract_atoms');
  });

  test('ALL_PHASES contains synthesize_concepts', () => {
    expect(ALL_PHASES).toContain('synthesize_concepts');
  });

  test('extract_atoms is positioned AFTER extract_facts (semantic ordering)', () => {
    const extractFactsIdx = ALL_PHASES.indexOf('extract_facts');
    const extractAtomsIdx = ALL_PHASES.indexOf('extract_atoms');
    expect(extractFactsIdx).toBeGreaterThan(-1);
    expect(extractAtomsIdx).toBeGreaterThan(extractFactsIdx);
  });

  test('synthesize_concepts is positioned AFTER patterns (graph-fresh semantics)', () => {
    const patternsIdx = ALL_PHASES.indexOf('patterns');
    const synthIdx = ALL_PHASES.indexOf('synthesize_concepts');
    expect(patternsIdx).toBeGreaterThan(-1);
    expect(synthIdx).toBeGreaterThan(patternsIdx);
  });

  test('PHASE_SCOPE declares extract_atoms as source-scoped', () => {
    expect(PHASE_SCOPE.extract_atoms).toBe('source');
  });

  test('PHASE_SCOPE declares synthesize_concepts as global-scoped', () => {
    expect(PHASE_SCOPE.synthesize_concepts).toBe('global');
  });

  test('every ALL_PHASES entry has a PHASE_SCOPE entry (exhaustive map)', () => {
    for (const p of ALL_PHASES) {
      expect(PHASE_SCOPE[p]).toBeDefined();
    }
  });
});

describe('v0.41 T9 R-GATE: NEEDS_LOCK_PHASES contract (source-shape)', () => {
  // NEEDS_LOCK_PHASES isn't exported; static-source assertion pins the
  // contract that both new phases acquire the cycle lock since they
  // mutate DB state (put_page atom/concept pages).
  test('cycle.ts source includes extract_atoms in NEEDS_LOCK_PHASES', () => {
    // Find the NEEDS_LOCK_PHASES block and assert both phases appear in it.
    const blockStart = cycleTsSrc.indexOf('NEEDS_LOCK_PHASES');
    expect(blockStart).toBeGreaterThan(-1);
    const blockEnd = cycleTsSrc.indexOf(']);', blockStart);
    expect(blockEnd).toBeGreaterThan(blockStart);
    const block = cycleTsSrc.slice(blockStart, blockEnd);
    expect(block).toContain("'extract_atoms'");
  });

  test('cycle.ts source includes synthesize_concepts in NEEDS_LOCK_PHASES', () => {
    const blockStart = cycleTsSrc.indexOf('NEEDS_LOCK_PHASES');
    const blockEnd = cycleTsSrc.indexOf(']);', blockStart);
    const block = cycleTsSrc.slice(blockStart, blockEnd);
    expect(block).toContain("'synthesize_concepts'");
  });
});

describe('v0.41 T9 R-GATE: orchestrator dispatch wires the pack-gate', () => {
  // Source-shape regression: the dispatch for each new phase MUST
  // consult packDeclaresPhase(engine, '<phase>') before invoking the
  // phase. Future refactors that accidentally drop the gate would still
  // pass happy-path runtime tests; this assertion catches the drop.
  test('cycle.ts dispatch for extract_atoms calls packDeclaresPhase', () => {
    expect(cycleTsSrc).toContain("packDeclaresPhase(engine, 'extract_atoms')");
  });

  test('cycle.ts dispatch for synthesize_concepts calls packDeclaresPhase', () => {
    expect(cycleTsSrc).toContain("packDeclaresPhase(engine, 'synthesize_concepts')");
  });

  test('packDeclaresPhase helper function exists in cycle.ts', () => {
    expect(cycleTsSrc).toContain('async function packDeclaresPhase(');
  });

  test('packDeclaresPhase reads phases from active pack manifest (NOT extends chain)', () => {
    // Source-pin: the helper reads `resolved.manifest.phases` — D4-B
    // says phases are local to the declaring manifest. Future drift
    // that adds extends-chain merging would silently change semantics
    // for users who extend gbrain-creator expecting inheritance; this
    // assertion catches it.
    expect(cycleTsSrc).toContain('resolved.manifest.phases');
  });

  test('packDeclaresPhase fail-open: returns false on catch (no thrown exceptions)', () => {
    // Source-pin: the helper's try/catch returns false on any error
    // (registry not initialized, pack not found, malformed manifest).
    // Skipping > crashing for an orchestrator gate.
    const helperStart = cycleTsSrc.indexOf('async function packDeclaresPhase(');
    expect(helperStart).toBeGreaterThan(-1);
    const helperEnd = cycleTsSrc.indexOf('\n}\n', helperStart);
    const helperBody = cycleTsSrc.slice(helperStart, helperEnd);
    expect(helperBody).toContain('catch');
    expect(helperBody).toContain('return false');
  });
});

describe('v0.41 T9 R-GATE: pre-existing 17 core phases always run', () => {
  // The IRON RULE that the wave depends on: pack-gating is ADDITIVE,
  // not subtractive. A user on gbrain-base (which declares phases:[])
  // must still see all 17 pre-existing phases run as before. The static
  // assertion: only the 2 new lens-pack phases reference packDeclaresPhase
  // in the dispatch.
  test('only extract_atoms + synthesize_concepts dispatch sites reference packDeclaresPhase', () => {
    const matches = cycleTsSrc.match(/packDeclaresPhase\(engine, '[^']+'\)/g) ?? [];
    const phaseNames = matches.map((m) => {
      const inner = /packDeclaresPhase\(engine, '([^']+)'\)/.exec(m);
      return inner ? inner[1] : '';
    });
    // Should be EXACTLY two phases gated.
    expect(phaseNames.sort()).toEqual(['extract_atoms', 'synthesize_concepts']);
  });

  test('extract_facts dispatch does NOT consult packDeclaresPhase', () => {
    // Pre-existing phase; must always run on every pack. Window scoped
    // to the SINGLE dispatch block — find the next `// ──` comment
    // marker (the next phase dispatch header) and stop there.
    const blockStart = cycleTsSrc.indexOf("if (phases.includes('extract_facts'))");
    expect(blockStart).toBeGreaterThan(-1);
    const blockEnd = cycleTsSrc.indexOf('// ──', blockStart + 10);
    expect(blockEnd).toBeGreaterThan(blockStart);
    const block = cycleTsSrc.slice(blockStart, blockEnd);
    expect(block).not.toContain('packDeclaresPhase');
  });

  test('calibration_profile dispatch does NOT consult packDeclaresPhase', () => {
    // Pre-existing v0.36.1.0 phase; always-on.
    const cpBlockStart = cycleTsSrc.indexOf("phases.includes('calibration_profile')");
    expect(cpBlockStart).toBeGreaterThan(-1);
    // Window of 1500 chars covers the dispatch.
    const block = cycleTsSrc.slice(cpBlockStart, cpBlockStart + 1500);
    expect(block).not.toContain('packDeclaresPhase');
  });
});

describe('v0.41 T9 R-GATE: dispatch result envelope', () => {
  test('extract_atoms not_in_active_pack skip carries the correct reason marker', () => {
    expect(cycleTsSrc).toContain("reason: 'not_in_active_pack'");
  });

  test('synthesize_concepts not_in_active_pack uses the same marker (semantic consistency)', () => {
    // Both phases should use identical reason marker — doctor can match
    // a single string across both pack-gated skip events.
    const occurrences = (cycleTsSrc.match(/reason: 'not_in_active_pack'/g) ?? []).length;
    expect(occurrences).toBe(2);
  });
});
