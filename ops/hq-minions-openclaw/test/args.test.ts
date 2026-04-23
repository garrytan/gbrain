import { describe, expect, test } from 'bun:test';
import { arr, bool, parseArgs, str } from '../src/args.ts';

describe('args', () => {
  test('parses repeatable flags', () => {
    const parsed = parseArgs(['create-work-item', '--project', 'hq', '--label', 'a', '--label', 'b', '--run-now']);
    expect(parsed.command).toBe('create-work-item');
    expect(str(parsed.flags, 'project')).toBe('hq');
    expect(arr(parsed.flags, 'label')).toEqual(['a', 'b']);
    expect(bool(parsed.flags, 'run-now')).toBe(true);
  });
});
