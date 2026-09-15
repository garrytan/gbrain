import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #4986: three code paths in src/commands/hook.ts spawn the workspace push —
// stopPushIfDue (Stop), hookSessionEnd (SessionEnd) and dirtyTreePush (the
// SessionStart crash-recovery push). Only the Stop path reads GBRAIN_STOP_PUSH
// and hooks.stop_push_debounce_min. The operator-facing table must say so and
// list the recovery push, or an operator tuning the debounce expects it to slow
// commits that the other two paths keep landing.
const rows = readFileSync(join(import.meta.dir, '..', 'docs/guides/bootstrap.md'), 'utf8').split('\n');

describe('#4986 bootstrap.md scopes the Stop-push knobs and lists every push path', () => {
  test('per-turn row says the switch + debounce govern the Stop path only', () => {
    const row = rows.find((l) => l.startsWith('| Per-turn persistence'));
    expect(row).toBeDefined();
    expect(row).toMatch(/Stop path only/);
  });

  test('session-end row names no switch/debounce; crash-recovery push has its own row', () => {
    const sessionEnd = rows.find((l) => l.startsWith('| Session persistence'));
    expect(sessionEnd).toBeDefined();
    expect(sessionEnd).toMatch(/no per-path switch or debounce/);
    expect(rows.some((l) => l.startsWith('| Crash recovery'))).toBe(true);
  });
});
