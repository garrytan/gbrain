import { describe, expect, test } from 'bun:test';
import { formatResult } from '../src/cli.ts';

/**
 * `gbrain history <slug> --json` accepted `--json` and silently printed the
 * human table anyway, and the human table appended `...` unconditionally —
 * so a body shorter than the preview width claimed a truncation that never
 * happened.
 */
describe('formatResult - get_versions --json', () => {
  test('--json returns parseable JSON carrying compiled_truth in full', () => {
    const body = 'x'.repeat(200);
    const out = formatResult('get_versions', [
      { id: 8, snapshot_at: '2026-01-02T03:04:05.000Z', compiled_truth: body },
    ], { json: true });

    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe(8);
    expect(parsed[0].compiled_truth).toBe(body);
    expect(parsed[0].compiled_truth.length).toBe(200);
  });

  test('--json keeps an empty history machine-readable', () => {
    expect(JSON.parse(formatResult('get_versions', [], { json: true }))).toEqual([]);
  });

  test('--json=false stays on the human path', () => {
    const out = formatResult('get_versions', [
      { id: 1, snapshot_at: '2026-01-02T03:04:05.000Z', compiled_truth: 'Short body.' },
    ], { json: false });

    expect(() => JSON.parse(out)).toThrow();
    expect(out).toContain('#1');
  });

  test('a body shorter than the preview width renders without an ellipsis', () => {
    const out = formatResult('get_versions', [
      { id: 7, snapshot_at: '2026-01-02T03:04:05.000Z', compiled_truth: 'Short body.' },
    ], {});

    expect(out.trimEnd().endsWith('Short body.')).toBe(true);
    expect(out).not.toContain('Short body....');
  });

  test('a body longer than the preview width is elided, once', () => {
    const out = formatResult('get_versions', [
      { id: 8, snapshot_at: '2026-01-02T03:04:05.000Z', compiled_truth: 'A'.repeat(200) },
    ], {});

    const line = out.trimEnd();
    expect(line.endsWith('...')).toBe(true);
    // 60 kept + the marker, not 200.
    expect((line.match(/A/g) ?? []).length).toBe(60);
  });

  test('the empty-history and missing-body human paths are unchanged', () => {
    expect(formatResult('get_versions', [], {})).toBe('No versions.\n');
    const out = formatResult('get_versions', [
      { id: 3, snapshot_at: undefined, compiled_truth: undefined },
    ], {});
    expect(out).toBe('#3  ?  \n');
  });
});
