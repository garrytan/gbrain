/**
 * Unit suite for the distiller's batch/adapter/resolver-sync modules.
 * Hermetic: pure functions + injected seams, no DB/LLM/network.
 */

import { describe, expect, test } from 'bun:test';
import { almageExportToRecords, inferRoleFromStaff } from '../src/core/distiller/adapters/almage.ts';
import { runDistillerBatch } from '../src/core/distiller/batch.ts';
import { categorizeUncategorizedRows, patientCareRules } from '../src/core/distiller/resolver-sync.ts';
import type { ExistingSkill } from '../src/core/distiller/types.ts';

// --- adapter ----------------------------------------------------------------

describe('almageExportToRecords', () => {
  const exportJson = {
    transmissions: [
      { id: 't1', staffRoleEn: 'Registered Nurse', category: 'medical', content: 'FR text', contentEn: 'Patient stable overnight', catalogTags: ['vitals'] },
      { id: 't2', staffRole: null, category: 'comment', categoryEn: 'Comment', content: 'wandered at night', contentEn: null },
      { id: 't3', category: 'medical', content: '   ', contentEn: null }, // empty → skipped
    ],
  };

  test('maps transmissions to BrainRecords, prefers English, skips empty', () => {
    const recs = almageExportToRecords(exportJson);
    expect(recs).toHaveLength(2); // t3 skipped
    expect(recs[0]).toMatchObject({ id: 't1', text: 'Patient stable overnight', role: 'nurse' });
    expect(recs[0].tags).toContain('medical');
    expect(recs[0].tags).toContain('vitals');
    expect(recs[1]).toMatchObject({ id: 't2', text: 'wandered at night', role: 'general-medicine' });
  });

  test('unknown/absent staff role defaults to general-medicine', () => {
    expect(inferRoleFromStaff(null)).toBeUndefined();
    expect(inferRoleFromStaff('Psychiatrist')).toBe('psychiatrist');
    expect(inferRoleFromStaff('Infirmière')).toBe('nurse');
    const recs = almageExportToRecords({ transmissions: [{ id: 'x', content: 'note' }] });
    expect(recs[0].role).toBe('general-medicine');
  });

  test('defaultRole override is honored', () => {
    const recs = almageExportToRecords({ transmissions: [{ id: 'x', content: 'note' }] }, { defaultRole: 'nurse' });
    expect(recs[0].role).toBe('nurse');
  });
});

// --- batch ------------------------------------------------------------------

describe('runDistillerBatch', () => {
  const library: ExistingSkill[] = [
    { name: 'nurse-triage', description: 'triage and vital signs', triggers: ['triage', 'vital signs'], role: 'nurse' },
  ];
  const deps = { loadExistingSkills: async () => library };

  test('extracts topics, decides each, aggregates a summary', async () => {
    const { summary, reports } = await runDistillerBatch(
      [
        { id: 'a', text: 'triage and vital signs check', role: 'nurse', tags: ['triage'] },
        { id: 'b', text: 'nutrition and hydration plan', role: 'nurse', tags: ['nutrition'] },
        { id: 'c', text: 'quarterly sales numbers', role: 'marketing', tags: ['sales'] }, // dropped
      ],
      deps,
    );
    expect(summary.records_in).toBe(3);
    expect(summary.dropped_non_clinical).toBe(1);
    expect(summary.topics).toBe(2); // triage + nutrition (both nurse)
    const total = Object.values(summary.by_decision).reduce((a, b) => a + b, 0);
    expect(total).toBe(reports.length);
    expect(reports.length).toBe(2);
  });
});

// --- resolver sync ----------------------------------------------------------

describe('categorizeUncategorizedRows', () => {
  const resolver = [
    '# Resolver',
    '',
    '## Patient care',
    '',
    '| Trigger | Skill |',
    '|---------|-------|',
    '| "chest pain" | `skills/nurse-triage/SKILL.md` (role: nurse) |',
    '',
    '## Uncategorized',
    '',
    '| Trigger | Skill |',
    '|---------|-------|',
    '| "wound care" | `skills/nurse-wound/SKILL.md` (role: nurse) |',
    '| "widget stuff" | `skills/widget/SKILL.md` |',
    '',
  ].join('\n');

  test('moves role-tagged rows into Patient care, leaves others', () => {
    const { content, moved, unresolvedTargets } = categorizeUncategorizedRows(resolver, patientCareRules());
    expect(moved).toHaveLength(1);
    expect(moved[0].target).toBe('Patient care');
    expect(unresolvedTargets).toHaveLength(0);

    // The nurse-wound row now sits under Patient care...
    const patientCareIdx = content.indexOf('## Patient care');
    const uncatIdx = content.indexOf('## Uncategorized');
    const woundIdx = content.indexOf('nurse-wound');
    expect(woundIdx).toBeGreaterThan(patientCareIdx);
    expect(woundIdx).toBeLessThan(uncatIdx);
    // ...and the non-role widget row stays in Uncategorized.
    expect(content.indexOf('widget')).toBeGreaterThan(uncatIdx);
  });

  test('no Uncategorized section → content unchanged', () => {
    const c = '# Resolver\n\n## Patient care\n\n| a | b |\n';
    expect(categorizeUncategorizedRows(c, patientCareRules()).content).toBe(c);
  });

  test('missing target section → row left in place, target reported', () => {
    const c = ['## Uncategorized', '', '| Trigger | Skill |', '|--|--|', '| "x" | `s` (role: nurse) |'].join('\n');
    const { moved, unresolvedTargets } = categorizeUncategorizedRows(c, patientCareRules());
    expect(moved).toHaveLength(0);
    expect(unresolvedTargets).toContain('Patient care');
  });
});
