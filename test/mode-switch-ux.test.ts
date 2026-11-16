/**
 * v0.40.3.0 — mode-switch UX (D3)
 *
 *   - summarizeTransition: 5-cell matrix + invalid fallthrough
 *   - runModeSwitchUx without a TTY: the banner names the synopsis sweep
 *     preview (#8744) and prompts for nothing. The TTY preview-and-ask path
 *     runs against a real brain in test/synopsis-sweep-8744.serial.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import { runModeSwitchUx, summarizeTransition } from '../src/core/search/mode-switch-ux.ts';
import { withEnv } from './helpers/with-env.ts';

describe('summarizeTransition (5-cell matrix + invalid fallthrough)', () => {
  test('any → tokenmax: tokenmax_opt_in with reindex required', () => {
    const s = summarizeTransition('balanced', 'tokenmax');
    expect(s.kind).toBe('tokenmax_opt_in');
    expect(s.reindex_required).toBe(true);
    expect(s.reindex_command).toBe('gbrain reindex --synopsis');
    expect(s.cost_estimate_per_query_cents).toBeGreaterThan(0);
    expect(s.callout_lines.some((l) => l.includes('tokenmax'))).toBe(true);
    // #8744: import and reindex --markdown embed at the title tier; only the synopsis sweep backfills.
    expect(s.callout_lines.some((l) => l.includes('`gbrain reindex --synopsis`'))).toBe(true);
    expect(s.callout_lines.join('\n')).not.toContain('reindex --markdown');
  });

  test('first-time any → tokenmax (null → tokenmax)', () => {
    const s = summarizeTransition(null, 'tokenmax');
    expect(s.kind).toBe('tokenmax_opt_in');
    expect(s.reindex_required).toBe(true);
  });

  test('balanced → conservative: narrowing, no reindex', () => {
    const s = summarizeTransition('balanced', 'conservative');
    expect(s.kind).toBe('narrowing');
    expect(s.reindex_required).toBe(false);
    expect(s.callout_lines.some((l) => l.includes('conservative'))).toBe(true);
  });

  test('tokenmax → balanced: narrowing (lower narrowness wins)', () => {
    const s = summarizeTransition('tokenmax', 'balanced');
    expect(s.kind).toBe('narrowing');
    expect(s.reindex_required).toBe(false);
  });

  test('conservative → balanced: broadening, no reindex', () => {
    const s = summarizeTransition('conservative', 'balanced');
    expect(s.kind).toBe('broadening');
    expect(s.reindex_required).toBe(false);
  });

  test('first-time set (null → balanced): broadening', () => {
    const s = summarizeTransition(null, 'balanced');
    expect(s.kind).toBe('broadening');
    expect(s.reindex_required).toBe(false);
    expect(s.callout_lines.some((l) => l.includes('First-time'))).toBe(true);
  });

  test('same → same: no_change with empty callout', () => {
    const s = summarizeTransition('balanced', 'balanced');
    expect(s.kind).toBe('no_change');
    expect(s.reindex_required).toBe(false);
    expect(s.callout_lines).toEqual([]);
  });

  test('any → invalid: invalid_new_mode with valid-options hint', () => {
    const s = summarizeTransition('balanced', 'not-a-real-mode');
    expect(s.kind).toBe('invalid_new_mode');
    expect(s.reindex_required).toBe(false);
    expect(s.callout_lines.some((l) => l.includes('conservative'))).toBe(true);
    expect(s.callout_lines.some((l) => l.includes('tokenmax'))).toBe(true);
  });
});

describe('runModeSwitchUx without a TTY', () => {
  const capture = async (newMode: string) => {
    const lines: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try {
      await withEnv({ GBRAIN_NO_MODE_SWITCH_UX: undefined }, () => runModeSwitchUx({ oldMode: 'balanced', newMode, engine: {} as never, isTty: false,
        answerFn: async () => { throw new Error('no prompt without a TTY'); } }));
    } finally {
      console.error = error;
    }
    return lines;
  };

  test('balanced → tokenmax: the banner names the free synopsis sweep preview, not reindex --markdown', async () => {
    const lines = await capture('tokenmax');
    expect(lines[0]).toBe('[mode-switch] Switched to tokenmax. Per-chunk Haiku synopsis enabled.');
    expect(lines.some((l) => l.includes('`gbrain reindex --synopsis`'))).toBe(true);
    expect(lines.at(-1)).toBe('[mode-switch] Preview the backfill (spends nothing): gbrain reindex --synopsis');
    expect(lines.join('\n')).not.toContain('reindex --markdown');
  });

  test('balanced → conservative: no backfill hint', async () => {
    const lines = await capture('conservative');
    expect(lines.join('\n')).not.toContain('reindex');
  });
});
