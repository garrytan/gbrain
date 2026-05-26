import { describe, expect, test } from 'bun:test';
import { ALL_PHASES, PHASE_SCOPE } from '../src/core/cycle.ts';
import { getDefaultDreamPhasesForScope } from '../src/commands/dream.ts';

describe('dream source scoping', () => {
  test('legacy dream keeps the full phase list when no source is requested', () => {
    expect(getDefaultDreamPhasesForScope(null)).toBeUndefined();
  });

  test('source-scoped dream defaults to source phases only', () => {
    const phases = getDefaultDreamPhasesForScope('obsidian-cody-safe');
    expect(phases).toBeDefined();
    expect(phases).toContain('sync');
    expect(phases).toContain('extract');
    expect(phases).toContain('extract_facts');
    expect(phases).not.toContain('patterns');
    expect(phases).not.toContain('embed');
    expect(phases).not.toContain('orphans');
    expect(phases).not.toContain('propose_takes');
    expect(phases).not.toContain('consolidate');
    expect(phases).not.toContain('extract_atoms');
    expect(phases!.every(phase => PHASE_SCOPE[phase] === 'source')).toBe(true);
    expect(phases!.length).toBeLessThan(ALL_PHASES.length);
  });

  test('source-scoped default phase list is returned as a fresh copy', () => {
    const phases = getDefaultDreamPhasesForScope('obsidian-cody-safe')!;
    phases.pop();
    expect(getDefaultDreamPhasesForScope('obsidian-cody-safe')).toContain('schema-suggest');
  });
});
