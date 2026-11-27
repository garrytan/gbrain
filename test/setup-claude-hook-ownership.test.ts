import { afterAll, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hookEntryHash, removeClaudeHooksAt, writeClaudeHooksAt } from '../src/core/bootstrap/hooks.ts';
import { GBRAIN_HOOK_MARKER_VALUE } from '../src/core/bootstrap/host-specs.ts';
import { createSetupFixture, readJson } from './helpers/setup-fixture.ts';

const { tempDir, cleanup } = createSetupFixture();
afterAll(cleanup);

describe('hooks.ts ownership: hash-keyed for setup, marker-keyed for bootstrap (unchanged)', () => {
  const env = { GBRAIN_SOURCE: 'default' };
  function editedFile(): string {
    const dir = tempDir('gbrain-hooks-own-');
    const path = join(dir, 'settings.json');
    writeClaudeHooksAt(path, { gbrainBin: '/usr/local/bin/gbrain', env, events: ['SessionStart'] });
    const s = readJson(path);
    s.hooks.SessionStart[0].hooks[0].command += ' --edited';
    writeFileSync(path, JSON.stringify(s));
    return path;
  }

  test('without ownedEntryHashes a marked entry is removed even when edited (bootstrap lanes keep their behavior)', () => {
    const path = editedFile();
    const r = removeClaudeHooksAt(path, GBRAIN_HOOK_MARKER_VALUE);
    expect(r.removed).toBe(1);
    expect(readJson(path).hooks).toBeUndefined();
  });

  test('with ownedEntryHashes an edited marked entry survives removal and rewrite, and is reported', () => {
    const path = editedFile();
    const before = readJson(path).hooks.SessionStart[0].hooks[0];
    const r = removeClaudeHooksAt(path, GBRAIN_HOOK_MARKER_VALUE, { ownedEntryHashes: new Set(['not-this-one']) });
    expect(r.removed).toBe(0);
    expect(r.preserved).toEqual([{ event: 'SessionStart', hash: hookEntryHash(before)! }]);
    const w = writeClaudeHooksAt(path, { gbrainBin: '/usr/local/bin/gbrain', env, events: ['UserPromptSubmit'], ownedEntryHashes: new Set() });
    expect(w.preserved).toHaveLength(1);
    expect(readJson(path).hooks.SessionStart[0].hooks[0]).toEqual(before);
  });

  test('hookEntryHash ignores the marker key and changes with the command or timeout', () => {
    const base = { type: 'command', command: 'env A=1 /bin/gbrain hook session-start', timeout: 5 };
    expect(hookEntryHash({ ...base, _gbrain: 'setup-v1' })).toBe(hookEntryHash(base));
    expect(hookEntryHash({ ...base, timeout: 6 })).not.toBe(hookEntryHash(base));
    expect(hookEntryHash({ ...base, command: `${base.command} x` })).not.toBe(hookEntryHash(base));
    expect(hookEntryHash({ type: 'other' })).toBeNull();
  });
});
