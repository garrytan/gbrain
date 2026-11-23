/**
 * GST-3170 item 0: mergeHiddenFactRows counts only the active private rows a remote write kept as stored, so a row the
 * owner already forgot never repeats the GST-3064 private_rows_kept notice; the forgotten row itself is still kept.
 */
import { describe, expect, test } from 'bun:test';
import { mergeHiddenFactRows } from '../src/core/import-hidden-rows.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';

const row = (n: number, claim: string, visibility: string, active = true) => ({ rowNum: n, claim, kind: 'fact', confidence: 1, visibility,
  notability: 'medium', active, ...(active ? {} : { forgotten: true, context: 'forgotten: owner withdrew it' }) });
const body = (rows: ReturnType<typeof row>[]) => '# Example\n\n## Facts\n\n' + renderFactsTable(rows as never) + '\n';

describe('mergeHiddenFactRows counts only active private rows (GST-3170)', () => {
  test('one active and one forgotten private row left out: both kept, only the active one counted', async () => {
    const stored = body([row(1, 'World fact example', 'world'), row(2, 'Active secret example', 'private'), row(3, 'Forgotten secret example', 'private', false)]);
    const parsed = { compiled_truth: body([row(1, 'World fact example, edited', 'world')]), timeline: '' };
    const kept = await mergeHiddenFactRows({} as never, 'notes/merge-example', parsed, { source_id: 'default', slug: 'notes/merge-example', compiled_truth: stored, timeline: '' } as never);
    expect(kept).toEqual({ count: 1, renumbered: 0 });
    expect(parsed.compiled_truth).toContain('Active secret example');
    expect(parsed.compiled_truth).toContain('~~Forgotten secret example~~');
    expect(parsed.compiled_truth).toContain('World fact example, edited');
  });

  test('a reworded forgotten row is kept but not counted as renumbered', async () => {
    const stored = body([row(1, 'World fact example', 'world'), row(2, 'Forgotten secret example', 'private', false)]);
    const parsed = { compiled_truth: body([row(1, 'World fact example', 'world'), row(2, 'Reworded example', 'world')]), timeline: '' };
    const kept = await mergeHiddenFactRows({} as never, 'notes/merge-example', parsed, { source_id: 'default', slug: 'notes/merge-example', compiled_truth: stored, timeline: '' } as never);
    expect(kept).toEqual({ count: 0, renumbered: 0 });
    expect(parsed.compiled_truth).toContain('~~Forgotten secret example~~');
    expect(parsed.compiled_truth).toContain('Reworded example');
  });
});
