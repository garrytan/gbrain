/**
 * #4585 — `bootstrap verify`'s hook_carrier_overlap must compare the ACTUAL
 * set of hook carriers Claude Code merges, not just the two workspace-scope
 * files. `bootstrap harness` wires hooks into user-scope ~/.claude/settings.json
 * while `bootstrap hooks` wires workspace-scope .claude/settings.local.json —
 * that cross-scope pair is a real per-event double-fire the pre-fix check
 * could structurally never flag. The event list must also cover every hook
 * the installers wire, including PreCompact.
 *
 * Unit-level: calls the exported check directly with an injected user-scope
 * path (no HOME mutation, no engine) — safe to run in parallel.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { checkHookCarrierOverlap } from '../src/core/bootstrap/verify.ts';
import { CLAUDE_HOOK_EVENTS } from '../src/core/bootstrap/host-specs.ts';

let root: string, ws: string, userSettings: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hco-'));
  ws = join(root, 'workspace');
  mkdirSync(ws, { recursive: true });
  userSettings = join(root, 'user-claude', 'settings.json');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a Claude settings file carrying gbrain-marked hooks for `events`
 * (the shape both installers' writers produce: hook command objects tagged
 * with the `_gbrain` marker key). */
function writeCarrier(path: string, events: readonly string[], marker = 'bootstrap-v1'): void {
  mkdirSync(dirname(path), { recursive: true });
  const hooks: Record<string, unknown> = {};
  for (const ev of events) {
    hooks[ev] = [{ hooks: [{ type: 'command', command: `gbrain hook ${ev.toLowerCase()}`, _gbrain: marker }] }];
  }
  writeFileSync(path, JSON.stringify({ hooks }, null, 2));
}

describe('checkHookCarrierOverlap (#4585)', () => {
  test('green when no carrier exists at all', () => {
    const check = checkHookCarrierOverlap(ws, userSettings);
    expect(check.ok).toBe(true);
    expect(check.detail).not.toContain('WARN');
  });

  test('green when each event fires from exactly one carrier (harness user-scope + disjoint workspace events)', () => {
    writeCarrier(userSettings, ['SessionStart', 'UserPromptSubmit', 'PreCompact'], 'bootstrap-harness-v1');
    writeCarrier(join(ws, '.claude', 'settings.local.json'), ['Stop', 'SessionEnd']);
    const check = checkHookCarrierOverlap(ws, userSettings);
    expect(check.ok).toBe(true);
    expect(check.detail).not.toContain('WARN');
  });

  test('flags the cross-scope overlap bootstrap harness + bootstrap hooks actually produce', () => {
    // The issue's live repro: all five events gbrain-marked in BOTH the
    // user-scope file (harness install) and the workspace-scope local file
    // (project install). Pre-fix this read green because the user-scope
    // carrier was never read.
    writeCarrier(userSettings, CLAUDE_HOOK_EVENTS, 'bootstrap-harness-v1');
    writeCarrier(join(ws, '.claude', 'settings.local.json'), CLAUDE_HOOK_EVENTS);
    const check = checkHookCarrierOverlap(ws, userSettings);
    expect(check.ok).toBe(true); // warn-only, never gating
    expect(check.detail).toContain('WARN');
    for (const ev of CLAUDE_HOOK_EVENTS) expect(check.detail).toContain(ev);
    // Names the offending pair so the operator knows WHICH files collide.
    expect(check.detail).toContain('user-scope settings.json');
    expect(check.detail).toContain('.claude/settings.local.json');
  });

  test('flags a same-scope overlap on PreCompact alone (pre-fix event list omitted it)', () => {
    writeCarrier(join(ws, '.claude', 'settings.json'), ['PreCompact']);
    writeCarrier(join(ws, '.claude', 'settings.local.json'), ['PreCompact']);
    const check = checkHookCarrierOverlap(ws, userSettings);
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('WARN');
    expect(check.detail).toContain('PreCompact');
    expect(check.detail).toContain('.claude/settings.json + .claude/settings.local.json');
  });

  test('still flags the original same-scope workspace overlap [D12]', () => {
    writeCarrier(join(ws, '.claude', 'settings.json'), ['SessionStart']);
    writeCarrier(join(ws, '.claude', 'settings.local.json'), ['SessionStart']);
    const check = checkHookCarrierOverlap(ws, userSettings);
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('WARN');
    expect(check.detail).toContain('SessionStart');
  });

  test('ignores non-gbrain hooks even when the same event fires from two carriers', () => {
    // A user's own (unmarked) hooks are not ours to flag.
    for (const path of [userSettings, join(ws, '.claude', 'settings.local.json')]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'my-own-hook' }] }] },
      }));
    }
    const check = checkHookCarrierOverlap(ws, userSettings);
    expect(check.ok).toBe(true);
    expect(check.detail).not.toContain('WARN');
  });

  test('a malformed carrier fails soft (treated as carrying nothing)', () => {
    writeCarrier(join(ws, '.claude', 'settings.local.json'), ['SessionStart']);
    mkdirSync(dirname(userSettings), { recursive: true });
    writeFileSync(userSettings, '{ not json');
    const check = checkHookCarrierOverlap(ws, userSettings);
    expect(check.ok).toBe(true);
    expect(check.detail).not.toContain('WARN');
  });
});
