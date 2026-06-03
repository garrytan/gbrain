import { describe, expect, test } from 'bun:test';

import {
  parseListOutput,
  parseListRow,
  summarizeRows,
} from '../scripts/gbrain-offramp-inventory.ts';

describe('gbrain-offramp-inventory helpers', () => {
  test('parseListRow keeps slug, type, updated date, and title', () => {
    const row = parseListRow(
      'ceo-plans/seascape-hub/2026-03-21-ops\tceo-plan\t2026-06-03\tSeascape operations OS',
    );

    expect(row).toEqual({
      slug: 'ceo-plans/seascape-hub/2026-03-21-ops',
      type: 'ceo-plan',
      updated: '2026-06-03',
      title: 'Seascape operations OS',
    });
  });

  test('parseListOutput keeps rows whose title field is empty', () => {
    const rows = parseListOutput('slug\ttype\t2026-06-03\t\n');

    expect(rows).toEqual([
      {
        slug: 'slug',
        type: 'type',
        updated: '2026-06-03',
        title: '',
      },
    ]);
  });

  test('summarizeRows groups by top-level directory and page type', () => {
    const summary = summarizeRows([
      {
        slug: 'transcripts/claude-code/_unattributed/session-a',
        type: 'transcript',
        updated: '2026-06-03',
        title: 'Session A',
      },
      {
        slug: 'transcripts/claude-code/_unattributed/session-b',
        type: 'transcript',
        updated: '2026-06-03',
        title: 'Session B',
      },
      {
        slug: 'design-docs/gbrain/phase-2b-dream-wiring',
        type: 'design-doc',
        updated: '2026-06-03',
        title: 'Dream wiring',
      },
    ]);

    expect(summary.totalRows).toBe(3);
    expect(summary.topLevelCounts).toEqual({
      'design-docs': 1,
      transcripts: 2,
    });
    expect(summary.typeCounts).toEqual({
      'design-doc': 1,
      transcript: 2,
    });
    expect(summary.sampleSlugs).toEqual([
      'transcripts/claude-code/_unattributed/session-a',
      'transcripts/claude-code/_unattributed/session-b',
      'design-docs/gbrain/phase-2b-dream-wiring',
    ]);
  });
});
