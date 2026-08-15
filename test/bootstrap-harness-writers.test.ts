/**
 * bootstrap-harness-writers.test.ts — harness-lane additions to the
 * settings writers (#4043: writeClaudeHooksAt/removeClaudeHooksAt marker
 * parameterization [C6], permissions.allow writers,
 * atomic-write hardening [C10], CODEX_HOME-aware codexConfigPath).
 *
 * Behavior-preservation for the workspace lane is pinned by the untouched
 * test/bootstrap-hooks-writers.test.ts — this file covers only what harness
 * mode adds.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addPermissionsAllowEntry,
  removePermissionsAllowEntry,
  removeClaudeHooksAt,
  writeClaudeHooksAt,
} from '../src/core/bootstrap/hooks.ts';
import {
  CLAUDE_HOOK_EVENTS,
  GBRAIN_HARNESS_MARKER_VALUE,
  GBRAIN_HOOK_MARKER_KEY,
  GBRAIN_HOOK_MARKER_VALUE,
  codexConfigPath,
  mcpPermissionEntry,
} from '../src/core/bootstrap/host-specs.ts';
import {
  deleteHarnessReceipt,
  guardHarnessReceiptOverwrite,
  harnessReceiptPath,
  readHarnessReceiptState,
  writeHarnessReceipt,
} from '../src/core/bootstrap/format.ts';
import { withEnv } from './helpers/with-env.ts';

const BIN = '/opt/fake/gbrain';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'gb-harness-writers-'));
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function markerEntries(settings: Record<string, unknown>, marker: string): number {
  let n = 0;
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      const entries = (g as { hooks?: unknown[] }).hooks;
      if (!Array.isArray(entries)) continue;
      for (const e of entries) {
        if ((e as Record<string, unknown>)[GBRAIN_HOOK_MARKER_KEY] === marker) n++;
      }
    }
  }
  return n;
}

describe('two-marker coexistence [C6]', () => {
  test('harness entries coexist with bootstrap-v1; each removal strips only its own', () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');

    writeClaudeHooksAt(path, { gbrainBin: BIN, env: { GBRAIN_SOURCE: 'ws' } });
    writeClaudeHooksAt(path, {
      gbrainBin: BIN,
      env: { GBRAIN_SOURCE: 'default' },
      marker: GBRAIN_HARNESS_MARKER_VALUE,
    });

    let settings = readJson(path);
    expect(markerEntries(settings, GBRAIN_HOOK_MARKER_VALUE)).toBe(CLAUDE_HOOK_EVENTS.length);
    expect(markerEntries(settings, GBRAIN_HARNESS_MARKER_VALUE)).toBe(CLAUDE_HOOK_EVENTS.length);

    const removed = removeClaudeHooksAt(path, GBRAIN_HARNESS_MARKER_VALUE);
    expect(removed.removed).toBe(CLAUDE_HOOK_EVENTS.length);
    settings = readJson(path);
    expect(markerEntries(settings, GBRAIN_HOOK_MARKER_VALUE)).toBe(CLAUDE_HOOK_EVENTS.length);
    expect(markerEntries(settings, GBRAIN_HARNESS_MARKER_VALUE)).toBe(0);
  });

  test('harness re-run dedupes on the harness marker only', () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    const opts = {
      gbrainBin: BIN,
      env: { GBRAIN_SOURCE: 'default' },
      marker: GBRAIN_HARNESS_MARKER_VALUE,
    };
    writeClaudeHooksAt(path, opts);
    const second = writeClaudeHooksAt(path, opts);
    expect(second.removedPrior).toBe(CLAUDE_HOOK_EVENTS.length);
    expect(markerEntries(readJson(path), GBRAIN_HARNESS_MARKER_VALUE)).toBe(CLAUDE_HOOK_EVENTS.length);
  });

  test('refuseOnForeignGbrainMarker: refuses when another gbrain marker wires a target event', () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    writeClaudeHooksAt(path, { gbrainBin: BIN, env: { GBRAIN_SOURCE: 'ws' } }); // bootstrap-v1

    expect(() =>
      writeClaudeHooksAt(path, {
        gbrainBin: BIN,
        env: { GBRAIN_SOURCE: 'default' },
        marker: GBRAIN_HARNESS_MARKER_VALUE,
        refuseOnForeignGbrainMarker: true,
      }),
    ).toThrow(/already wires hooks\..* under gbrain marker "bootstrap-v1"/);

    // untouched: still exactly the bootstrap-v1 entries
    expect(markerEntries(readJson(path), GBRAIN_HOOK_MARKER_VALUE)).toBe(CLAUDE_HOOK_EVENTS.length);
    expect(markerEntries(readJson(path), GBRAIN_HARNESS_MARKER_VALUE)).toBe(0);
  });

  test('refuseOnForeignGbrainMarker: foreign UNMARKED hooks never trip the refusal', () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    writeFileSync(
      path,
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }),
    );
    const res = writeClaudeHooksAt(path, {
      gbrainBin: BIN,
      env: { GBRAIN_SOURCE: 'default' },
      marker: GBRAIN_HARNESS_MARKER_VALUE,
      refuseOnForeignGbrainMarker: true,
    });
    expect(res.installed.length).toBe(CLAUDE_HOOK_EVENTS.length);
    const groups = (readJson(path).hooks as Record<string, unknown[]>).SessionStart;
    const flat = groups.flatMap((g) => ((g as { hooks?: unknown[] }).hooks ?? []) as unknown[]);
    expect(flat.some((e) => (e as { command?: string }).command === 'echo hi')).toBe(true);
  });
});

describe('broken JSON is fail-closed', () => {
  test('write throws and leaves the file untouched (never relocate a config we cannot read)', () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    const broken = '{ "hooks": { // JSONC comment\n } }';
    writeFileSync(path, broken);
    expect(() =>
      writeClaudeHooksAt(path, {
        gbrainBin: BIN,
        env: { GBRAIN_SOURCE: 'default' },
        marker: GBRAIN_HARNESS_MARKER_VALUE,
      }),
    ).toThrow(/refusing to rewrite/);
    expect(readFileSync(path, 'utf8')).toBe(broken);
  });

  test('workspace-lane writes are fail-closed too', () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    const broken = 'not json at all';
    writeFileSync(path, broken);
    expect(() => writeClaudeHooksAt(path, { gbrainBin: BIN, env: { GBRAIN_SOURCE: 'ws' } })).toThrow(
      /refusing to rewrite/,
    );
    expect(readFileSync(path, 'utf8')).toBe(broken);
  });
});

describe('permissions.allow writers', () => {
  test('fresh file: permissions.allow created with exactly our entry', () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    const res = addPermissionsAllowEntry(path, mcpPermissionEntry('gbrain'));
    expect(res.added).toBe(true);
    const settings = readJson(path);
    expect((settings.permissions as { allow: string[] }).allow).toEqual(['mcp__gbrain']);
  });

  test('foreign allow entries + other keys survive; re-add is a no-op', () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    writeFileSync(
      path,
      JSON.stringify({
        permissions: { allow: ['Bash(ls:*)'], deny: ['WebFetch'] },
        model: 'opus',
      }),
    );
    addPermissionsAllowEntry(path, 'mcp__gbrain');
    const again = addPermissionsAllowEntry(path, 'mcp__gbrain');
    expect(again.added).toBe(false);
    const settings = readJson(path);
    expect((settings.permissions as { allow: string[] }).allow).toEqual(['Bash(ls:*)', 'mcp__gbrain']);
    expect((settings.permissions as { deny: string[] }).deny).toEqual(['WebFetch']);
    expect(settings.model).toBe('opus');
  });

  test('removal removes exactly our string; foreign entries survive', () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({ permissions: { allow: ['Bash(ls:*)', 'mcp__gbrain'] } }));
    const res = removePermissionsAllowEntry(path, 'mcp__gbrain');
    expect(res.removed).toBe(1);
    expect((readJson(path).permissions as { allow: string[] }).allow).toEqual(['Bash(ls:*)']);
  });

  test('removal drops keys only when OUR removal emptied them', () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({ permissions: { allow: ['mcp__gbrain'] } }));
    removePermissionsAllowEntry(path, 'mcp__gbrain');
    const settings = readJson(path);
    expect(settings.permissions).toBeUndefined();
  });

  test('removal of a missing entry / missing file is a calm no-op', () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    expect(removePermissionsAllowEntry(path, 'mcp__gbrain').removed).toBe(0);
    writeFileSync(path, JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }));
    expect(removePermissionsAllowEntry(path, 'mcp__gbrain').removed).toBe(0);
  });

  test('broken JSON: add aborts, remove leaves untouched with a note', () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    const broken = '{ broken';
    writeFileSync(path, broken);
    expect(() => addPermissionsAllowEntry(path, 'mcp__gbrain')).toThrow(/refusing to rewrite/);
    const res = removePermissionsAllowEntry(path, 'mcp__gbrain');
    expect(res.removed).toBe(0);
    expect(res.notes.join(' ')).toMatch(/left untouched/);
    expect(readFileSync(path, 'utf8')).toBe(broken);
  });

  test('non-object permissions / non-array allow FAIL CLOSED — security policy is never rewritten', () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    const weird = JSON.stringify({ permissions: 'weird' });
    writeFileSync(path, weird);
    expect(() => addPermissionsAllowEntry(path, 'mcp__gbrain')).toThrow(/refusing to rewrite security policy/);
    expect(readFileSync(path, 'utf8')).toBe(weird); // untouched

    const badAllow = JSON.stringify({ permissions: { allow: 'not-an-array', deny: ['WebFetch'] } });
    writeFileSync(path, badAllow);
    expect(() => addPermissionsAllowEntry(path, 'mcp__gbrain')).toThrow(/refusing to rewrite security policy/);
    expect(readFileSync(path, 'utf8')).toBe(badAllow);
  });
});

describe('atomic-write hardening [C10]', () => {
  test('0600 file stays 0600 after write (mode preservation)', () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{}', { mode: 0o600 });
    addPermissionsAllowEntry(path, 'mcp__gbrain');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('symlinked settings file survives as a symlink (realpath write)', () => {
    const dir = tmp();
    const real = join(dir, 'dotfiles', 'claude-settings.json');
    mkdirSync(join(dir, 'dotfiles'), { recursive: true });
    writeFileSync(real, JSON.stringify({ model: 'opus' }));
    const link = join(dir, 'settings.json');
    symlinkSync(real, link);

    addPermissionsAllowEntry(link, 'mcp__gbrain');

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(real));
    expect((readJson(real).permissions as { allow: string[] }).allow).toEqual(['mcp__gbrain']);
    expect(readJson(real).model).toBe('opus');
  });

  test('timestamped backup strategy leaves distinct backups for sequential writes', async () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{}');
    const first = writeClaudeHooksAt(path, {
      gbrainBin: BIN,
      env: { GBRAIN_SOURCE: 'a' },
      marker: GBRAIN_HARNESS_MARKER_VALUE,
      backupStrategy: 'timestamped',
    });
    await new Promise((r) => setTimeout(r, 2));
    const second = writeClaudeHooksAt(path, {
      gbrainBin: BIN,
      env: { GBRAIN_SOURCE: 'b' },
      marker: GBRAIN_HARNESS_MARKER_VALUE,
      backupStrategy: 'timestamped',
    });
    expect(first.backupPath).not.toBeNull();
    expect(second.backupPath).not.toBeNull();
    expect(first.backupPath).not.toBe(second.backupPath);
  });
});

describe('harness receipt (format.ts, CX2-12 discipline)', () => {
  test('write-ahead round trip: 0600 file, typed read states, guard semantics', () => {
    const home = tmp();
    const receipt = {
      harness_receipt_version: 1 as const,
      created_at: '2026-08-12T00:00:00Z',
      created_by: 'gbrain@test',
      url: 'http://127.0.0.1:3131/mcp',
      engine: 'postgres',
      serve_version: '0.45.7.0',
      source_id: 'default',
      token: { name: 'bootstrap-harness', id: '00000000-0000-0000-0000-000000000000', minted: true },
      targets: [
        { host: 'claude-code' as const, kind: 'mcp' as const, state: 'pending' as const, scope: 'user', name: 'gbrain' },
      ],
    };
    expect(readHarnessReceiptState(home)).toEqual({ state: 'absent' });
    writeHarnessReceipt(home, receipt);
    expect(statSync(harnessReceiptPath(home)).mode & 0o777).toBe(0o600);
    const state = readHarnessReceiptState(home);
    expect(state.state).toBe('ok');
    expect((state as { receipt: typeof receipt }).receipt.targets[0].state).toBe('pending');

    // newer-format refusal (never silently clobber a newer gbrain's receipt)
    writeFileSync(harnessReceiptPath(home), JSON.stringify({ harness_receipt_version: 2 }));
    expect(readHarnessReceiptState(home).state).toBe('newer');
    expect(() => guardHarnessReceiptOverwrite(home)).toThrow(/newer gbrain/);

    // broken receipt → backed up aside, never silently discarded
    writeFileSync(harnessReceiptPath(home), 'not json');
    expect(readHarnessReceiptState(home).state).toBe('invalid');
    const guard = guardHarnessReceiptOverwrite(home);
    expect(guard.brokenBackupPath).toMatch(/\.broken-/);
    expect(readHarnessReceiptState(home)).toEqual({ state: 'absent' });

    // consume
    writeHarnessReceipt(home, receipt);
    deleteHarnessReceipt(home);
    expect(readHarnessReceiptState(home)).toEqual({ state: 'absent' });
  });
});

describe('codexConfigPath honors CODEX_HOME', () => {
  test('CODEX_HOME set → config.toml directly inside it; unset → ~/.codex/config.toml', async () => {
    const dir = tmp();
    await withEnv({ CODEX_HOME: dir }, async () => {
      expect(codexConfigPath()).toBe(join(dir, 'config.toml'));
    });
    await withEnv({ CODEX_HOME: undefined }, async () => {
      expect(codexConfigPath()).toContain(join('.codex', 'config.toml'));
    });
    await withEnv({ CODEX_HOME: '   ' }, async () => {
      expect(codexConfigPath()).toContain(join('.codex', 'config.toml')); // blank trims to falsy
    });
  });
});
